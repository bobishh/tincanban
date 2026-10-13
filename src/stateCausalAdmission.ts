import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { validateWorkspaceDoc } from "./domain/model"
import { exportDocumentAuthorizationBundle, evaluateIncomingWorkspaceAdmission, storedWorkspaceAdmissionIsCurrent, workspaceAuthorityIsInvalid, workspaceWritesBlocked } from "./sync/changeAuthorization"
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import { peerStore } from "./sync/peerStore"
import { defaultStorage } from "./storage"
import { withWorkspaceMutation } from "./workspaceMutation"
import { stateRuntime } from "./stateContext"
import { meshTrace } from "./sync/meshTrace"
import { diagnoseStartupStep } from "./sync/startupDiagnostics"
import { reusableDeltaAdmission } from "./stateDeltaAdmission"

export async function assertWorkspaceWritesAllowed(workspaceId?: string): Promise<void> {
  if (!workspaceId) return
  if (typeof indexedDB !== "undefined" && await peerStore.getPendingOwnershipTransfer(workspaceId))
    throw new Error("Ownership transfer is awaiting confirmation. Reconnect and retry the same recipient.")
  if (await workspaceWritesBlocked(workspaceId)) throw new Error("Workspace writes paused: conflicting ownership records")
}

export async function reclassifyStoredWorkspace(workspaceId: string, storage = defaultStorage): Promise<{
  doc: Automerge.Doc<WorkspaceDocumentV2> | undefined
  changed: boolean
}> {
  const startedAt = performance.now()
  let stage = "waiting-for-lock"
  meshTrace("workspace.reclassify.started", { workspaceId })
  const phase = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    stage = name
    const phaseStartedAt = performance.now()
    const result = await diagnoseStartupStep(`reclassify-${name}`, operation, { workspaceId })
    meshTrace("workspace.reclassify.phase", { workspaceId, stage: name, phase: name,
      elapsedMs: Math.round(performance.now() - phaseStartedAt) })
    return result
  }
  return withWorkspaceMutation(workspaceId, async () => {
    const loaded = await phase("load-document", () => storage.loadWorkspaceDoc(workspaceId))
    if (!loaded) return { doc: undefined, changed: false }
    // Keep the last admitted projection available if its local authority record
    // is malformed. Raw causal bytes may contain unreviewed changes, so this
    // branch must neither replay them nor persist a new classification.
    if (await phase("validate-authority", () => workspaceAuthorityIsInvalid(workspaceId))) return { doc: loaded.doc, changed: false }
    if (await phase("reuse-delta-projection", () => reusableDeltaAdmission(loaded.doc, storage, stateRuntime.currentProfile ?? undefined))) {
      meshTrace("workspace.reclassify.reused", { workspaceId })
      return { doc: loaded.doc, changed: false }
    }
    const evidence = await phase("load-evidence", () => storage.loadCausalEvidence(workspaceId))
    const authorization = await phase("export-authorization", () => exportDocumentAuthorizationBundle(loaded.doc, stateRuntime.currentProfile ?? undefined))
    if (evidence && await phase("reuse-projection", () => storedWorkspaceAdmissionIsCurrent(loaded.doc, evidence, authorization))) {
      meshTrace("workspace.reclassify.reused", { workspaceId })
      return { doc: loaded.doc, changed: false }
    }
    const rawBytes = evidence ? new Uint8Array(evidence.bytes) : Automerge.save(loaded.doc)
    const raw = Automerge.load<WorkspaceDocumentV2>(rawBytes)
    try {
      const admission = await phase("admit-history", () => evaluateIncomingWorkspaceAdmission(raw, raw, authorization,
        (evidence?.authorizationEvidence ?? []) as WorkspaceChangeAuthorization[]))
      stage = "validate-projection"
      const doc = Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument)
      const validation = validateWorkspaceDoc(doc)
      if (!validation.ok) {
        Automerge.free(doc)
        throw new Error(`Invalid authorized workspace projection: ${validation.error.message}`)
      }
      if (doc.ownerPersonId !== loaded.doc.ownerPersonId) {
        Automerge.free(doc)
        throw new Error("Workspace ownership cannot change through reclassification.")
      }
      const result = await phase("commit", () => storage.commitWorkspace(workspaceId, doc, Automerge.save(doc),
        admission.verifiedAuthorizations as WorkspaceChangeAuthorization[], undefined, {
          bytes: admission.rawBytes,
          decisions: admission.decisions,
          authorizationEvidence: admission.authorizationEvidence,
          admissionCheckpoint: admission.admissionCheckpoint,
        }, commitPhase => {
          stage = `commit-${commitPhase}`
          meshTrace("workspace.commit.phase", { workspaceId, phase: commitPhase,
            elapsedMs: Math.round(performance.now() - startedAt) })
        }))
      const documentChanged = !sameHeads(doc, loaded.doc)
      return { doc, changed: documentChanged || result.proofChanged || result.causalChanged }
    } finally { Automerge.free(raw) }
  }).then(result => {
    meshTrace("workspace.reclassify.completed", { workspaceId, changed: result.changed,
      elapsedMs: Math.round(performance.now() - startedAt) })
    return result
  }).catch(error => {
    meshTrace("workspace.reclassify.failed", { workspaceId, stage,
      elapsedMs: Math.round(performance.now() - startedAt),
      reason: error instanceof Error ? error.message : String(error) }, "warn")
    throw error
  })
}

function sameHeads(left: Automerge.Doc<WorkspaceDocumentV2>, right: Automerge.Doc<WorkspaceDocumentV2>): boolean {
  return Automerge.getHeads(left).sort().join() === Automerge.getHeads(right).sort().join()
}
