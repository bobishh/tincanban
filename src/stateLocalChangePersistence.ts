import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { assertWorkspaceCapability, assertWorkspaceCommand, type WorkspaceRole } from "./domain/permissions"
import type { LocalProfile } from "./domain/identity"
import { executeCommand, type Command, type ExecuteResult } from "./domain/commands"
import {
  evaluateIncomingWorkspaceAdmission,
  exportDocumentAuthorizationBundle,
  prepareLocalChangeAuthorizations,
  localChangeAuthorityGrantHash,
  workspaceRole,
} from "./sync/changeAuthorization"
import { mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"
import type { WorkspaceStorage, WorkspaceTransactionContext } from "./storage"
import { assertWorkspaceWritesAllowed } from "./stateCausalAdmission"
import { causalReviewMetadata, hasUnresolvedCausalChanges } from "./stateCausalReviewMetadata"
import { persistDeltaCommand } from "./stateDeltaAdmission"
import { canReuseAdmittedDocument } from "./sync/localAdmissionReuse"
import { meshTrace } from "./sync/meshTrace"

export async function commitAuthorizedCommand(
  doc: Automerge.Doc<WorkspaceDocumentV2>, command: Command,
  profile: LocalProfile, storage: WorkspaceStorage,
  transaction: WorkspaceTransactionContext,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  await assertWorkspaceWritesAllowed(doc.id)
  const role = await workspaceRole(doc, profile)
  if (command.kind !== "setMemberAvatar") ensureContentWrite(role)
  assertWorkspaceCommand(role, doc, command)
  const authorityGrantHash = await localChangeAuthorityGrantHash(doc.id, profile.identity.personId, command.kind === "setMemberAvatar")
  const { localCommandSigningContext } = await import("./sync/localCommandSigning")
  const signingContext = await localCommandSigningContext(doc, profile, async () => {
    await assertWorkspaceWritesAllowed(doc.id)
    assertWorkspaceCommand(await workspaceRole(doc, profile), doc, command)
  })
  const result = await executeCommand(doc, command, profile, undefined, authorityGrantHash, signingContext)
  if (!result.ok) throw new Error(`Command failed: [${result.error.code}] ${result.error.message}`)
  return persistNewLocalChange(doc, result.value, profile, storage, undefined, role, transaction)
}

type CreatedLocalChange = Extract<ExecuteResult, { ok: true }>['value']

export async function persistNewLocalChange(
  base: Automerge.Doc<WorkspaceDocumentV2>, created: CreatedLocalChange,
  profile: LocalProfile, storage: WorkspaceStorage, reviewedChangeHash: string | undefined,
  localRole: WorkspaceRole | undefined, transaction: WorkspaceTransactionContext,
): Promise<Automerge.Doc<WorkspaceDocumentV2>> {
  await assertWorkspaceWritesAllowed(base.id)
  const changeBytes = Automerge.getLastLocalChange(created.newDoc)
  if (!changeBytes) throw new Error("No change produced")
  const authorizations = await prepareLocalChangeAuthorizations(created.newDoc, profile, [created.receipt.changeHash], undefined, base)
  const deltaDoc = await persistDeltaCommand(base, created, changeBytes, authorizations, profile, transaction,
    localRole, reviewedChangeHash)
  if (deltaDoc) {
    tracePersistedLocalChange(base.id, created, deltaDoc, changeBytes)
    return deltaDoc
  }
  const bundle = await exportDocumentAuthorizationBundle(base, profile)
  const receivedBasis = await transaction.getVerifiedReceivedHistoryBaseline()
  const previousEvidence = await transaction.loadCausalEvidence()
  bundle.records = mergeAuthorizationRecords(bundle.records, authorizations)
  // An all-admitted evidence snapshot is already represented by the authorized
  // base document. Reuse it instead of synchronously loading the full raw
  // history on every local write. Keep loading raw bytes when quarantined or
  // pending branches must remain available for reclassification.
  const preserveRawHistory = hasUnresolvedCausalChanges(previousEvidence)
  const rawBase = preserveRawHistory ? Automerge.load<WorkspaceDocumentV2>(previousEvidence!.bytes) : base
  let admission: Awaited<ReturnType<typeof evaluateIncomingWorkspaceAdmission>>
  try {
    admission = await evaluateIncomingWorkspaceAdmission(rawBase, created.newDoc, bundle,
      (previousEvidence?.authorizationEvidence ?? []) as WorkspaceChangeAuthorization[], receivedBasis)
  } finally {
    if (preserveRawHistory) Automerge.free(rawBase)
  }
  const decision = admission.decisions.find(item => item.hash === created.receipt.changeHash)
  if (decision?.status.type !== "admitted")
    throw new Error(decision?.status.type === "quarantined" || decision?.status.type === "pending"
      ? `Local change failed causal admission: ${decision.status.reason}`
      : "Local change missing from causal admission")
  // A fully admitted plan leaves the locally created document unchanged. It is
  // already an Automerge handle, so loading the worker's equivalent snapshot
  // would decode the entire large workspace again on the UI thread.
  const allChangesAdmitted = canReuseAdmittedDocument(admission, Automerge.getHeads(created.newDoc))
  const authorizedDoc = allChangesAdmitted
    ? created.newDoc
    : Automerge.load<WorkspaceDocumentV2>(admission.authorizedDocument)
  const reviewMetadata = causalReviewMetadata(previousEvidence, reviewedChangeHash, created.receipt.changeHash)
  const evidence = {
    bytes: admission.rawBytes, decisions: admission.decisions, authorizationEvidence: admission.authorizationEvidence,
    admissionCheckpoint: admission.admissionCheckpoint, ...reviewMetadata,
  }
  await transaction.commitWorkspace(authorizedDoc, Automerge.save(authorizedDoc), admission.verifiedAuthorizations, {
    receipt: created.receipt, changeBytes, proof: created.proof,
  }, evidence)
  if (allChangesAdmitted) (await import("./sync/workspaceAccess")).inheritLocalMoveAccess(base, authorizedDoc)
  tracePersistedLocalChange(base.id, created, authorizedDoc, changeBytes)
  return authorizedDoc
}

function tracePersistedLocalChange(workspaceId: string, created: CreatedLocalChange,
  doc: Automerge.Doc<WorkspaceDocumentV2>, changeBytes: Uint8Array): void {
  meshTrace("document.persisted", { workspaceId, recordId: created.receipt.changeHash, changeId: created.receipt.changeHash,
    phase: "local", component: "automerge", heads: Automerge.getHeads(doc), bytes: changeBytes.byteLength })
}

function ensureContentWrite(role: WorkspaceRole): void {
  if (role === "visitor") assertWorkspaceCapability(role, "content.write")
}
