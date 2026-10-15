import * as Automerge from "@automerge/automerge/slim"
import type { LocalProfile } from "./domain/identity"
import { canonicalizeJson } from "./domain/identity"
import type { WorkspaceDocumentV2 } from "./domain/model"
import type { WorkspaceStorage } from "./storage"
import { readWorkspaceBasisSnapshot } from "./storageJournal"
import { createDeltaBasis, type WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"
import { basisRecords, mergeAuthorizationRecords } from "./sync/workspaceChangeProofStore"
import { localWorkspaceAdmissionAuthority, storedWorkspaceAdmissionIsCurrent } from "./sync/changeAuthorization"
import { admissionPolicy } from "./sync/workspaceAdmissionCheckpoint"
import { assertLocalCommandTransition } from "./sync/localCommandTransition"
import { prepareWorkspaceDelta } from "./workspaceDeltaJournal"
import type { ChangeProof, TransactionReceipt } from "./domain/model"
import type { WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import type { WorkspaceRole } from "./domain/permissions"
import { meshTrace } from "./sync/meshTrace"

type Validated = { generation: string; basisHash: string; authority: string; descriptor: string }
const validated = new Map<string, Validated>()

function rememberDeltaAdmission(frontier: WorkspaceDeltaFrontier) {
  validated.delete(frontier.workspaceId)
  validated.set(frontier.workspaceId, { generation: frontier.generation, basisHash: frontier.basisHash,
    authority: frontier.authorityFingerprint, descriptor: canonicalizeJson(frontier) })
  if (validated.size > 8) validated.delete(validated.keys().next().value!)
}

/** Validate a basis once. Later commands check only current authority and the durable local frontier. */
export async function reusableDeltaAdmission(doc: Automerge.Doc<WorkspaceDocumentV2>, storage: WorkspaceStorage,
  profile?: LocalProfile): Promise<WorkspaceDeltaFrontier | undefined> {
  const frontier = await storage.readDeltaFrontier(doc.id)
  if (!frontier) return installDeltaAdmission(doc, storage, profile)
  if (frontier.invalidated || frontier.policy !== admissionPolicy() ||
    frontier.heads.join() !== Automerge.getHeads(doc).sort().join()) return
  const current = await localWorkspaceAdmissionAuthority(doc, profile)
  if (current.fingerprint !== frontier.authorityFingerprint) return
  const previous = validated.get(doc.id)
  if (previous?.descriptor === canonicalizeJson(frontier)) return frontier
  const checked = await storage.readDeltaWorkspace(doc.id)
  if (!checked || canonicalizeJson(checked.frontier) !== canonicalizeJson(frontier)) return
  // Another tab may have appended verified local commands to this exact basis.
  if (!matchesBasis(previous, frontier)) {
    const receivedBasis = await storage.getVerifiedReceivedHistoryBaseline(doc.id)
    const basisDoc = Automerge.load<WorkspaceDocumentV2>(checked.basis.bytes)
    try {
      const proofs = await basisRecords(doc.id)
      const bundle = { version: 1 as const, records: mergeAuthorizationRecords(proofs,
        checked.basis.causalEvidence!.authorizationEvidence as typeof proofs ?? []), authority: current.authority }
      if (!await storedWorkspaceAdmissionIsCurrent(basisDoc, checked.basis.causalEvidence!, bundle, proofs, receivedBasis)) return
    } finally { Automerge.free(basisDoc) }
  }
  if ((await localWorkspaceAdmissionAuthority(doc, profile)).fingerprint !== current.fingerprint) return
  rememberDeltaAdmission(frontier)
  return frontier
}

function matchesBasis(previous: Validated | undefined, frontier: WorkspaceDeltaFrontier) {
  return previous?.generation === frontier.generation && previous.basisHash === frontier.basisHash && previous.authority === frontier.authorityFingerprint
}

export async function persistDeltaCommand(base: Automerge.Doc<WorkspaceDocumentV2>,
  created: { newDoc: Automerge.Doc<WorkspaceDocumentV2>; receipt: TransactionReceipt; proof: ChangeProof },
  changeBytes: Uint8Array, authorizations: WorkspaceChangeAuthorization[], profile: LocalProfile,
  storage: WorkspaceStorage, role?: WorkspaceRole, reviewedChangeHash?: string) {
  if (role === undefined || reviewedChangeHash !== undefined) return
  const frontier = await reusableDeltaAdmission(base, storage, profile)
  if (!frontier) return
  await assertLocalCommandTransition(base, created.newDoc, created.receipt, changeBytes, authorizations, role, profile)
  const delta = await prepareWorkspaceDelta(frontier, { receipt: created.receipt, changeBytes, proof: created.proof,
    authorizations, role, title: created.newDoc.title, archivedAt: created.newDoc.archivedAt ?? null })
  if ((await localWorkspaceAdmissionAuthority(base, profile)).fingerprint !== frontier.authorityFingerprint)
    throw new Error("Workspace authority changed during validation. Retry synchronization.")
  rememberDeltaAdmission(await storage.commitDelta(frontier, delta, created.newDoc))
  const { inheritLocalMoveAccess } = await import("./sync/workspaceAccess")
  inheritLocalMoveAccess(base, created.newDoc)
  meshTrace("workspace.admission.local-extended", { workspaceId: base.id, changeId: created.receipt.changeHash, checkedChanges: 1 })
  return created.newDoc
}

async function installDeltaAdmission(doc: Automerge.Doc<WorkspaceDocumentV2>, storage: WorkspaceStorage, profile?: LocalProfile) {
  const receivedBasis = await storage.getVerifiedReceivedHistoryBaseline(doc.id)
  const snapshot = await readWorkspaceBasisSnapshot(doc.id)
  const evidence = snapshot?.causalEvidence
  if (!snapshot || !evidence?.admissionCheckpoint || evidence.admissionCheckpoint.incremental ||
    evidence.admissionCheckpoint.policy !== admissionPolicy() || evidence.decisions.some(decision => decision.status.type !== "admitted") ||
    snapshot.heads.join() !== Automerge.getHeads(doc).sort().join()) return
  const current = await localWorkspaceAdmissionAuthority(doc, profile)
  const proofs = await basisRecords(doc.id)
  const bundle = { version: 1 as const, records: mergeAuthorizationRecords(proofs,
    evidence.authorizationEvidence as typeof proofs ?? []), authority: current.authority }
  if (!await storedWorkspaceAdmissionIsCurrent(doc, evidence, bundle, proofs, receivedBasis)) return
  const frontier = await createDeltaBasis(snapshot, current.fingerprint)
  if ((await localWorkspaceAdmissionAuthority(doc, profile)).fingerprint !== current.fingerprint ||
    !await storage.installDeltaBasis(snapshot, frontier, proofs, doc)) return
  rememberDeltaAdmission(frontier)
  return frontier
}
