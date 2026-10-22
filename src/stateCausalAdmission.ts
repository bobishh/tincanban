import type { Context } from "@opentelemetry/api"
import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { validateWorkspaceDoc } from "./domain/model"
import { exportDocumentAuthorizationBundle, evaluateIncomingWorkspaceAdmission, storedWorkspaceAdmissionIsCurrent, workspaceAuthorityIsInvalid, workspaceWritesBlocked } from "./sync/changeAuthorization"
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import { peerStore } from "./sync/peerStore"
import { defaultStorage } from "./storage"
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

export async function reclassifyStoredWorkspace(workspaceId: string, storage = defaultStorage, diagnosticContext?: Context): Promise<{
  doc: Automerge.Doc<WorkspaceDocumentV2> | undefined
  changed: boolean
}> {
  const startedAt = performance.now()
  let stage = "waiting-for-lock"
  meshTrace("workspace.reclassify.started", { workspaceId })
  const phase = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    stage = name
    const phaseStartedAt = performance.now()
    const result = await diagnoseStartupStep(`reclassify-${name}`, operation, { workspaceId }, diagnosticContext)
    meshTrace("workspace.reclassify.phase", { workspaceId, stage: name, phase: name,
      elapsedMs: Math.round(performance.now() - phaseStartedAt) })
    return result
  }
  return storage.withWorkspaceTransaction(workspaceId, async transaction => {
    const loaded = await phase("load-document", () => transaction.loadWorkspaceDoc())
    if (!loaded) return { doc: undefined, changed: false }
    let returnedLoaded = false
    let returnedProjection = false
    let raw: Automerge.Doc<WorkspaceDocumentV2> | undefined
    let projection: Automerge.Doc<WorkspaceDocumentV2> | undefined
    try {
      const receivedBasis = await phase("load-history-basis", () => transaction.getVerifiedReceivedHistoryBaseline())
      // Keep the last admitted projection available if its local authority record
      // is malformed. Raw causal bytes may contain unreviewed changes, so this
      // branch must neither replay them nor persist a new classification.
      if (await phase("validate-authority", () => workspaceAuthorityIsInvalid(workspaceId))) {
        returnedLoaded = true
        return { doc: loaded.doc, changed: false }
      }
      if (await phase("reuse-projection", () => reusableDeltaAdmission(loaded.doc, transaction,
        stateRuntime.currentProfile ?? undefined))) {
        meshTrace("workspace.reclassify.reused", { workspaceId })
        returnedLoaded = true
        return { doc: loaded.doc, changed: false }
      }
      const evidence = await phase("load-evidence", () => transaction.loadCausalEvidence())
      const authorization = await phase("export-authorization", () => exportDocumentAuthorizationBundle(loaded.doc, stateRuntime.currentProfile ?? undefined))
      if (evidence && await phase("reuse-projection", () => storedWorkspaceAdmissionIsCurrent(loaded.doc, evidence, authorization,
        undefined, receivedBasis))) {
        meshTrace("workspace.reclassify.reused", { workspaceId })
        returnedLoaded = true
        return { doc: loaded.doc, changed: false }
      }
      const rawBytes = evidence ? new Uint8Array(evidence.bytes) : Automerge.save(loaded.doc)
      const rawDocument = Automerge.load<WorkspaceDocumentV2>(rawBytes)
      raw = rawDocument
      const admission = await phase("admit-history", () => evaluateIncomingWorkspaceAdmission(rawDocument, rawDocument, authorization,
        (evidence?.authorizationEvidence ?? []) as WorkspaceChangeAuthorization[], receivedBasis))
      stage = "validate-projection"
      projection = Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument)
      const validation = validateWorkspaceDoc(projection)
      if (!validation.ok) {
        throw new Error(`Invalid authorized workspace projection: ${validation.error.message}`)
      }
      if (projection.ownerPersonId !== loaded.doc.ownerPersonId) {
        throw new Error("Workspace ownership cannot change through reclassification.")
      }
      const result = await phase("commit", () => transaction.commitWorkspace(projection!, Automerge.save(projection!),
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
      const documentChanged = !sameHeads(projection!, loaded.doc)
      returnedProjection = true
      return { doc: projection!, changed: documentChanged || result.proofChanged || result.causalChanged }
    } finally {
      if (raw) Automerge.free(raw)
      if (projection && !returnedProjection) Automerge.free(projection)
      if (!returnedLoaded) Automerge.free(loaded.doc)
    }
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
