import * as Automerge from "@automerge/automerge/slim"
import { createPairingSecret } from "@meta-uber/mesh-pairing"
import { canonicalizeJson, sha256Base64Url, type LocalProfile } from "../domain/identity"
import { type DeviceAuthorizationApproval } from "@meta-uber/mesh-identity"
import type { DeviceCertificate, WorkspaceDocumentV2, WorkspaceGrant } from "../domain/model"
import type { WorkspaceSetStore } from "./workspaceSet"
import { defaultStorage, type WorkspaceAuthorityMutationContext } from "../storage"
import { workspaceRole } from "./changeAuthorization"
import { applyOwnershipSteps, createOwnershipProposal, planOwnershipMerge } from "./durableMeshOwnershipScope"
import { verifyWorkspaceGrant } from "./meshRecords"
import { peerStore, type PeerStore, type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import type { ScopeAuthoritySnapshot } from "./durableMeshBase"
import { clearLocalWorkspaceOwnershipIntent, persistLocalWorkspaceOwnershipIntent,
  readLocalWorkspaceOwnershipIntent } from "./localWorkspaceOwnershipIntent"
import type { LocalWorkspaceOwnerReference, LocalWorkspaceOwnershipIntent, LocalWorkspaceTransferPlan }
  from "./localWorkspaceOwnershipIntent"

type LocalOwnershipTransferInput = {
  sourceProfile: LocalProfile
  approvedTarget: DeviceAuthorizationApproval
  workspaceStore: Pick<WorkspaceSetStore, "read" | "readAuthorityHeads">
  ensureCurrent: () => void | Promise<void>
  store: PeerStore
}

export async function readPendingLocalWorkspaceOwnershipIntent(sourceProfile: LocalProfile,
  targetPersonId: string): Promise<string[]> {
  const intent = await readLocalWorkspaceOwnershipIntent(sourceProfile.device.deviceId)
  if (!intent) return []
  if (intent.sourcePersonId !== sourceProfile.identity.personId || intent.deviceId !== sourceProfile.device.deviceId ||
      intent.targetPersonId !== targetPersonId) throw new Error("A different local workspace transfer must be completed first")
  return intent.workspaceIds
}

export async function completePendingLocalWorkspaceOwnershipTransfer(input: {
  profile: LocalProfile
  workspaceStore: Pick<WorkspaceSetStore, "read">
  registerOwnerReference: (reference: LocalWorkspaceOwnerReference) => Promise<void>
  ensureCurrent?: () => void | Promise<void>
}): Promise<LocalWorkspaceOwnerReference[]> {
  const raw = await readLocalWorkspaceOwnershipIntent(input.profile.device.deviceId)
  if (!raw) return []
  if (raw.deviceId !== input.profile.device.deviceId) throw new Error("Local workspace transfer belongs to another app device")
  if (raw.sourcePersonId === input.profile.identity.personId) return []
  if (raw.stage !== "transferred" || raw.targetPersonId !== input.profile.identity.personId ||
      raw.targetPublicKey !== input.profile.identity.publicKey || !raw.references) {
    throw new Error("Local workspace ownership transfer is waiting for its approved Identity adoption")
  }
  const ensureCurrent = input.ensureCurrent ?? (() => {})
  await ensureCurrent()
  const references = await Promise.all(raw.workspaceIds.map(workspaceId =>
    readTargetOwnerReference(workspaceId, input.profile, input.workspaceStore, peerStore)))
  const byId = new Map(references.map(reference => [reference.workspaceId, reference]))
  const verified = raw.references.map(reference => {
    const current = byId.get(reference.workspaceId)
    if (!current || current.ownerGrantHash !== reference.ownerGrantHash) {
      throw new Error("Transferred workspace owner grant changed before catalog registration")
    }
    return current
  })
  for (const reference of verified) {
    await ensureCurrent()
    await input.registerOwnerReference(reference)
  }
  await ensureCurrent()
  if (!await clearLocalWorkspaceOwnershipIntent(raw)) throw new Error("Local workspace transfer intent changed before completion")
  return verified
}

async function readTargetOwnerReference(workspaceId: string, target: Pick<LocalProfile, "identity">,
  workspaceStore: Pick<WorkspaceSetStore, "read">, store: PeerStore): Promise<LocalWorkspaceOwnerReference> {
  const credential = await store.getWorkspaceCredential(workspaceId)
  const ownerGrant = credential?.localGrant as WorkspaceGrant | undefined
  if (!credential || credential.workspaceId !== workspaceId || credential.ownerPersonId !== target.identity.personId ||
      credential.ownerPublicKey !== target.identity.publicKey || !ownerGrant ||
      await verifyWorkspaceGrant(ownerGrant, { workspaceId, personId: target.identity.personId,
        ownerPersonId: target.identity.personId, ownerPublicKey: target.identity.publicKey,
        ownerCertificates: credential.ownerCertificates as DeviceCertificate[] }) !== "owner") {
    throw new Error("Transferred workspace owner authority is unavailable")
  }
  const bytes = await workspaceStore.read(workspaceId)
  const doc = Automerge.load<WorkspaceDocumentV2>(bytes)
  try { if (doc.id !== workspaceId) throw new Error("Transferred workspace document binding changed") }
  finally { Automerge.free(doc) }
  return { workspaceId, ownerGrantHash: await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(ownerGrant))) }
}

function assertApprovedSameDevice(sourceProfile: LocalProfile, target: DeviceAuthorizationApproval) {
  if (target.identity.personId === sourceProfile.identity.personId ||
    target.certificate.payload.personId !== target.identity.personId ||
    target.certificate.payload.deviceId !== sourceProfile.device.deviceId ||
    target.certificate.payload.devicePublicKey !== sourceProfile.device.publicKey ||
    !target.certificates.some(certificate => canonicalizeJson(certificate) === canonicalizeJson(target.certificate))) {
    throw new Error("Approved Identity device does not match the local app key")
  }
}

async function readSourceOwnedCredential(workspaceId: string, input: LocalOwnershipTransferInput,
  context: WorkspaceAuthorityMutationContext) {
  const { sourceProfile, workspaceStore, store, ensureCurrent } = input
  const [bytes, heads, existing, authority] = await Promise.all([
    workspaceStore.read(workspaceId), workspaceStore.readAuthorityHeads!(workspaceId),
    store.getWorkspaceCredential(workspaceId), store.getWorkspaceAuthority(workspaceId),
  ])
  const owner = existing ?? authority
  if (!owner || owner.ownerPersonId !== sourceProfile.identity.personId || owner.ownerPublicKey !== sourceProfile.identity.publicKey) {
    throw new Error("Current local workspace owner authority is unavailable")
  }
  const doc = Automerge.load<WorkspaceDocumentV2>(bytes)
  try {
    if (doc.id !== workspaceId || canonicalizeJson(Automerge.getHeads(doc).sort()) !== canonicalizeJson(heads.slice().sort()) ||
      await workspaceRole(doc, sourceProfile) !== "owner") {
      throw new Error("Selected workspace is no longer locally owned")
    }
  } finally { Automerge.free(doc) }
  await ensureCurrent()
  if (await store.getPendingOwnershipTransfer(workspaceId)) {
    throw new Error("A workspace ownership transfer is already pending")
  }
  if (existing) return existing
  // An unshared board has signed authority but no transport projection yet.
  // Persist only that projection; ownership stays unchanged until the durable transfer plan.
  const credential: WorkspaceMeshCredential = { ...owner, transportSecret: createPairingSecret() }
  await context.write(async () => { await ensureCurrent(); await store.putWorkspaceCredential(credential) })
  const stored = await store.getWorkspaceCredential(workspaceId)
  if (!stored) throw new Error("Local workspace transport projection is unavailable")
  return stored
}

async function prepareLocalOwnershipAdoption(workspaceId: string, credential: WorkspaceMeshCredential,
  input: LocalOwnershipTransferInput) {
  const { sourceProfile, approvedTarget, workspaceStore, store } = input
  const targetIdentity = approvedTarget.identity
  const proposal = await createOwnershipProposal(sourceProfile, workspaceId, {
    payload: { personId: targetIdentity.personId }, publicKey: targetIdentity.publicKey,
    certificates: approvedTarget.certificates,
  }, credential, store, workspaceStore)
  const plan = planOwnershipMerge(credential, [proposal.transfer])
  if (plan.steps.length !== 1 || plan.steps[0]?.record.signature !== proposal.transfer.signature) {
    throw new Error("Selected workspace ownership changed before local transfer")
  }
  const { credential: nextCredential, peers } = await applyOwnershipSteps(store, credential, plan, targetIdentity.personId)
  const ownerGrant = nextCredential.localGrant as WorkspaceGrant | undefined
  if (nextCredential.ownerPersonId !== targetIdentity.personId || nextCredential.ownerPublicKey !== targetIdentity.publicKey ||
    !ownerGrant || ownerGrant.payload.workspaceId !== workspaceId || ownerGrant.payload.personId !== targetIdentity.personId ||
    ownerGrant.payload.role !== "owner" || canonicalizeJson(ownerGrant) !== canonicalizeJson(proposal.transfer.payload.toOwnerGrant)) {
    throw new Error("Signed local workspace owner admission did not match the approved Identity")
  }
  return { nextCredential, peers, ownerGrant, scopeAuthoritySnapshot: proposal.scopeAuthoritySnapshot }
}

async function withWorkspaceAuthorityMutations<T>(workspaceIds: string[], index: number,
  contexts: Map<string, WorkspaceAuthorityMutationContext>, operation: () => Promise<T>): Promise<T> {
  if (index >= workspaceIds.length) return operation()
  const workspaceId = workspaceIds[index]!
  return defaultStorage.withWorkspaceAuthorityMutation(workspaceId, async context => {
    contexts.set(workspaceId, context)
    try { return await withWorkspaceAuthorityMutations(workspaceIds, index + 1, contexts, operation) }
    finally { contexts.delete(workspaceId) }
  })
}

/** Transfer already-owned local workspaces to the approved same-device Identity, without peer sessions. */
export async function transferLocallyOwnedWorkspaces(input: {
  sourceProfile: LocalProfile
  approvedTarget: DeviceAuthorizationApproval
  workspaceIds: string[]
  workspaceStore: Pick<WorkspaceSetStore, "read" | "readAuthorityHeads">
  ensureCurrent?: () => void | Promise<void>
  store?: PeerStore
}): Promise<LocalWorkspaceOwnerReference[]> {
  const { sourceProfile, approvedTarget, workspaceIds, workspaceStore } = input
  const store = input.store ?? peerStore
  const ensureCurrent = input.ensureCurrent ?? (() => {})
  if (!workspaceIds.length || new Set(workspaceIds).size !== workspaceIds.length) throw new Error("Selected workspaces are invalid")
  assertApprovedSameDevice(sourceProfile, approvedTarget)
  if (!workspaceStore.readAuthorityHeads) throw new Error("Admitted workspace document unavailable for ownership signing")
  const selectedIds = [...workspaceIds].sort()
  const intent: LocalWorkspaceOwnershipIntent = { version: 1, stage: "requested", sourcePersonId: sourceProfile.identity.personId,
    targetPersonId: approvedTarget.identity.personId, targetPublicKey: approvedTarget.identity.publicKey,
    deviceId: sourceProfile.device.deviceId, workspaceIds: selectedIds }

  const contexts = new Map<string, WorkspaceAuthorityMutationContext>()
  const transferInput: LocalOwnershipTransferInput = { sourceProfile, approvedTarget, workspaceStore, ensureCurrent, store }
  return withWorkspaceAuthorityMutations(selectedIds, 0, contexts, () => completeTransferUnderLocks(transferInput, selectedIds, intent, contexts))
}

async function completeTransferUnderLocks(input: LocalOwnershipTransferInput, selectedIds: string[], initial: LocalWorkspaceOwnershipIntent,
  contexts: Map<string, WorkspaceAuthorityMutationContext>): Promise<LocalWorkspaceOwnerReference[]> {
  const pending = await readLocalWorkspaceOwnershipIntent(input.sourceProfile.device.deviceId) ?? initial
  assertSameTransferIntent(pending, initial)
  if (pending.stage === "transferred" && pending.references) return verifyCompletedReferences(pending, input)
  const plans = await loadOrCreateTransferPlans(pending, selectedIds, input, contexts)
  await applyLocalTransferPlans(plans, contexts, input)
  const references = await Promise.all(selectedIds.map(workspaceId =>
    readTargetOwnerReference(workspaceId, input.approvedTarget, input.workspaceStore, input.store)))
  references.sort((left, right) => left.workspaceId.localeCompare(right.workspaceId))
  await persistLocalWorkspaceOwnershipIntent({ version: 1, stage: "transferred", sourcePersonId: pending.sourcePersonId,
    targetPersonId: pending.targetPersonId, targetPublicKey: pending.targetPublicKey,
    deviceId: pending.deviceId, workspaceIds: pending.workspaceIds, references })
  return references
}

function assertSameTransferIntent(pending: LocalWorkspaceOwnershipIntent, initial: LocalWorkspaceOwnershipIntent) {
  if (pending.targetPersonId !== initial.targetPersonId || pending.targetPublicKey !== initial.targetPublicKey ||
      pending.sourcePersonId !== initial.sourcePersonId || canonicalizeJson(pending.workspaceIds) !== canonicalizeJson(initial.workspaceIds)) {
    throw new Error("Local workspace transfer intent changed before admission")
  }
}

async function verifyCompletedReferences(intent: LocalWorkspaceOwnershipIntent, input: LocalOwnershipTransferInput) {
  const verified = await Promise.all(intent.workspaceIds.map(workspaceId =>
    readTargetOwnerReference(workspaceId, input.approvedTarget, input.workspaceStore, input.store)))
  if (canonicalizeJson(verified) !== canonicalizeJson(intent.references)) {
    throw new Error("Transferred workspace owner grant changed before Identity adoption")
  }
  return verified
}

async function loadOrCreateTransferPlans(intent: LocalWorkspaceOwnershipIntent, workspaceIds: string[],
  input: LocalOwnershipTransferInput, contexts: Map<string, WorkspaceAuthorityMutationContext>): Promise<LocalWorkspaceTransferPlan[]> {
  if (intent.plans) return intent.plans
  const prepared: Array<{ source: WorkspaceMeshCredential; workspaceId: string; next: WorkspaceMeshCredential;
    peers: WorkspacePeerRecord[]; scopeAuthoritySnapshot?: ScopeAuthoritySnapshot }> = []
  for (const workspaceId of workspaceIds) {
    await input.ensureCurrent()
    const context = contexts.get(workspaceId)
    if (!context) throw new Error("Local workspace authority lock is unavailable")
    const credential = await readSourceOwnedCredential(workspaceId, input, context)
    const { nextCredential, peers, scopeAuthoritySnapshot } =
      await prepareLocalOwnershipAdoption(workspaceId, credential, input)
    prepared.push({ source: credential, workspaceId, next: nextCredential, peers, scopeAuthoritySnapshot })
  }
  const plans = await Promise.all(prepared.map(async item => ({ workspaceId: item.workspaceId,
    previousOwnerPersonId: item.source.ownerPersonId,
    sourceCredentialHash: await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(item.source))),
    nextCredential: item.next, peers: item.peers, ...(item.scopeAuthoritySnapshot
      ? { scopeAuthoritySnapshot: item.scopeAuthoritySnapshot } : {}) })))
  await persistLocalWorkspaceOwnershipIntent({ ...intent, plans })
  return plans
}

async function applyLocalTransferPlans(plans: LocalWorkspaceTransferPlan[], contexts: Map<string, WorkspaceAuthorityMutationContext>,
  input: LocalOwnershipTransferInput) {
  await input.ensureCurrent()
  for (const plan of plans) {
    const context = contexts.get(plan.workspaceId)
    if (!context) throw new Error("Workspace authority lock is unavailable")
    await applyLocalTransferPlan(plan, context, input)
  }
}

async function applyLocalTransferPlan(plan: LocalWorkspaceTransferPlan, context: WorkspaceAuthorityMutationContext,
  input: LocalOwnershipTransferInput) {
  await input.ensureCurrent()
  const current = await input.store.getWorkspaceCredential(plan.workspaceId)
  if (!current) throw new Error("Local workspace credential disappeared before transfer recovery")
  if (canonicalizeJson(current) !== canonicalizeJson(plan.nextCredential)) {
    const currentHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(current)))
    if (currentHash !== plan.sourceCredentialHash || current.ownerPersonId !== plan.previousOwnerPersonId) {
      throw new Error("Local workspace authority changed during transfer recovery")
    }
    await context.write(() => input.store.transferWorkspaceCredential(plan.previousOwnerPersonId, plan.nextCredential,
      plan.scopeAuthoritySnapshot))
  }
  for (const peer of plan.peers) {
    await input.ensureCurrent()
    await context.write(() => input.store.upsertPeer(peer))
  }
}
