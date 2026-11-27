import type { Context } from "@opentelemetry/api"
import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { validateWorkspaceDoc } from "./domain/model"
import { sha256Base64Url } from "./domain/identityCrypto"
import { exportDocumentAuthorizationBundle, evaluateIncomingWorkspaceAdmission, localWorkspaceAdmissionAuthority, storedWorkspaceAdmissionIsCurrent, workspaceAuthorityIsInvalid } from "./sync/changeAuthorization"
import { admissionPolicy } from "./sync/workspaceAdmissionCheckpoint"
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import { defaultStorage } from "./storage"
import type { LoadedWorkspaceDocument } from "./storageTransactionAccess"
import { stateRuntime } from "./stateContext"
import { meshTrace } from "./sync/meshTrace"
import { diagnoseStartupStep } from "./sync/startupDiagnostics"
import { reusableDeltaAdmission } from "./stateDeltaAdmission"
import { migrateOwnedWorkspace } from "./stateWorkspaceMigration"
import { commitAuthorizedCommand } from "./stateLocalChangePersistence"

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
      if (await matchesStartupAdmission(loaded, transaction.capturedRevision,
        () => phase("startup-admission", () => startupAuthorityHash(loaded.doc)))) {
        returnedLoaded = true
        return { doc: loaded.doc, changed: false }
      }
      const migrated = await migrateOwnedWorkspace(loaded.doc, stateRuntime.currentProfile, (source, profile) =>
        phase("migrate-workspace", () => commitAuthorizedCommand(source, { kind: "migrateWorkspaceFormat" },
          profile, storage, transaction)))
      if (migrated !== loaded.doc) {
        projection = migrated
        returnedProjection = true
        return { doc: migrated, changed: true }
      }
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
        await rememberStartupAdmission(storage, loaded.doc, false)
        returnedLoaded = true
        return { doc: loaded.doc, changed: false }
      }
      const evidence = await phase("load-evidence", () => transaction.loadCausalEvidence())
      const authorization = await phase("export-authorization", () => exportDocumentAuthorizationBundle(loaded.doc, stateRuntime.currentProfile ?? undefined))
      if (evidence && await phase("reuse-projection", () => storedWorkspaceAdmissionIsCurrent(loaded.doc, evidence, authorization,
        undefined, receivedBasis))) {
        meshTrace("workspace.reclassify.reused", { workspaceId })
        await rememberStartupAdmission(storage, loaded.doc, evidence.decisions.some(decision => decision.status.type !== "admitted"))
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
      assertAdmissionProjection(projection, loaded.doc.ownerPersonId)
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
      const documentChanged = !sameWorkspaceHeads(projection!, loaded.doc)
      await rememberStartupAdmission(storage, projection, admission.decisions.some(decision => decision.status.type !== "admitted"))
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

function assertAdmissionProjection(doc: Automerge.Doc<WorkspaceDocumentV2>, ownerPersonId: string) {
  const validation = validateWorkspaceDoc(doc)
  if (!validation.ok) throw new Error(`Invalid authorized workspace projection: ${validation.error.message}`)
  if (doc.ownerPersonId !== ownerPersonId) throw new Error("Workspace ownership cannot change through reclassification.")
}

async function matchesStartupAdmission(loaded: LoadedWorkspaceDocument, capturedRevision: string | null,
  currentAuthorityHash: () => Promise<string | undefined>): Promise<boolean> {
  const saved = loaded.startupAdmission
  return saved?.policy === admissionPolicy() && saved.revision === capturedRevision &&
    typeof saved.authorityHash === "string" && saved.authorityHash === await currentAuthorityHash()
}

async function startupAuthorityHash(doc: Automerge.Doc<WorkspaceDocumentV2>): Promise<string | undefined> {
  const profile = stateRuntime.currentProfile
  try {
    const { fingerprint } = await localWorkspaceAdmissionAuthority(doc, profile ?? undefined)
    const hash = await sha256Base64Url(new TextEncoder().encode(JSON.stringify(
      [profile?.identity.personId, profile?.device.deviceId, fingerprint],
    )))
    if (profile === stateRuntime.currentProfile) return hash
  } catch { return undefined }
}

async function rememberStartupAdmission(storage: typeof defaultStorage, doc: Automerge.Doc<WorkspaceDocumentV2>, needsReview: boolean) {
  try {
    const revision = await storage.readWorkspaceRevision(doc.id)
    const authorityHash = revision && await startupAuthorityHash(doc)
    if (!authorityHash || !revision) return
    await storage.rememberStartupAdmission(doc.id, revision, {
      policy: admissionPolicy(), authorityHash, heads: Automerge.getHeads(doc).sort(), needsReview,
    })
  } catch {
    meshTrace("workspace.reclassify.startup-admission-cache-failed", { workspaceId: doc.id }, "warn")
  }
}

export function sameWorkspaceHeads(left: Automerge.Doc<WorkspaceDocumentV2>, right: Automerge.Doc<WorkspaceDocumentV2>): boolean {
  return Automerge.getHeads(left).sort().join() === Automerge.getHeads(right).sort().join()
}
