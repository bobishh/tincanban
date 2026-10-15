import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { type LocalProfile } from "../domain/identity"
import { signWithContext } from "../domain/signingContext"
import { workspaceOwnerSigningContext } from "./workspaceOwnerSigning"
import { meshRecordSigning } from "./meshRecordSigning"
import type { DeviceCertificate } from "../domain/model"
import type { WorkspaceSetStore } from "./workspaceSet"
import { publishConfirmedWorkspace, workspaceSet } from "./workspaceSet"
import type { WorkspaceOwnershipTransfer, WorkspaceRevocation, WorkspaceSuccessionClaim, WorkspaceSuccessionPolicy,
  WorkspaceSuccessionVote, WorkspaceMemberBundle, verifyWorkspaceMemberBundle } from "./meshRecords"
import { createWorkspaceOwnershipTransfer } from "./meshRecords"
import type { PeerStore, WorkspaceMeshCredential, WorkspacePeerRecord } from "./peerStore"
import { meshCatalog, ownerAuthorities, ownershipTransfers, revocations, revokedPersonIds, successionClaims, successionPolicy,
  successionVotes, type MeshExport, type ScopeAuthoritySnapshot } from "./durableMeshBase"
import type { SessionEntry } from "./durableMeshBase"

type VerifiedWorkspaceMember = Awaited<ReturnType<typeof verifyWorkspaceMemberBundle>>
export type OwnershipTransferState = {
  profile: LocalProfile
  credential: WorkspaceMeshCredential
  sessions: SessionEntry[]
  targetAdvertisement?: WorkspaceMemberBundle
  target?: VerifiedWorkspaceMember
  transfer?: WorkspaceOwnershipTransfer
  current: WorkspaceMeshCredential
  nextScopeAuthoritySnapshot?: ScopeAuthoritySnapshot
}

export type OwnershipMergePlan = {
  accepted: WorkspaceOwnershipTransfer[]
  steps: Array<{ record: WorkspaceOwnershipTransfer; accepted: WorkspaceOwnershipTransfer[]; previousOwnerEpoch: number }>
  persistCatalog: boolean
}

function appendScopeSuccessionTransfer(snapshot: ScopeAuthoritySnapshot, claim: WorkspaceSuccessionClaim,
  credentialRevocations: WorkspaceRevocation[]): ScopeAuthoritySnapshot {
  const state = meshRustRuntime().state
  const current = state.validateScopeAuthority(snapshot, Date.now()) as {
    scopeId: string; controller: { personId: string; publicKey: string }; controlEpoch: number
  }
  if (current.scopeId !== claim.payload.workspaceId || current.controller.personId !== claim.payload.fromOwnerPersonId)
    throw new Error("Scope succession claim does not match current controller")
  const next = { ...snapshot, successionTransfers: [...(snapshot.successionTransfers ?? []), {
    fromControlEpoch: current.controlEpoch, claim, revocations: credentialRevocations,
  }] }
  state.validateScopeAuthority(next, Date.now())
  return next
}

function scopeSnapshotThroughEpoch(snapshot: ScopeAuthoritySnapshot, controlEpoch: number): ScopeAuthoritySnapshot {
  const grants = snapshot.grants.filter(record => (record as { payload: { controlEpoch: number } }).payload.controlEpoch <= controlEpoch)
  const grantIds = new Set(grants.map(record => (record as { payload: { grantId: string } }).payload.grantId))
  return {
    ...snapshot,
    grants,
    grantIssuers: snapshot.grantIssuers.filter(record => grantIds.has((record as { grantId: string }).grantId)),
    revocations: snapshot.revocations.filter(record =>
      (record as { payload: { controlEpoch: number } }).payload.controlEpoch <= controlEpoch),
    controlTransfers: snapshot.controlTransfers.filter(record => {
      const fromEpoch = (record as { payload?: { fromControlEpoch?: number } }).payload?.fromControlEpoch
      return fromEpoch !== undefined && fromEpoch < controlEpoch
    }),
    successionTransfers: (snapshot.successionTransfers ?? []).filter(record => record.fromControlEpoch < controlEpoch),
  }
}

function planSuccession(credential: WorkspaceMeshCredential, rawPolicy: WorkspaceSuccessionPolicy | undefined,
  rawVotes: WorkspaceSuccessionVote[], rawClaims: WorkspaceSuccessionClaim[]) {
  return meshRustRuntime().state.planSuccessionMerge({ workspaceId: credential.workspaceId,
    owner: { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
      certificates: credential.ownerCertificates }, ownerHistory: ownerAuthorities(credential), epoch: credential.epoch,
    currentPolicy: successionPolicy(credential) ?? null, currentVotes: successionVotes(credential), currentClaims: successionClaims(credential),
    incomingPolicy: rawPolicy ?? null, incomingVotes: rawVotes, incomingClaims: rawClaims,
    revokedPeople: [...revokedPersonIds(credential)], revokedBeforeEpoch: [...new Set(revocations(credential)
      .filter(record => record.payload.epoch < credential.epoch).map(record => record.payload.personId))],
  }, Date.now()) as { noop: boolean; policy?: WorkspaceSuccessionPolicy; votes: WorkspaceSuccessionVote[];
    claims: WorkspaceSuccessionClaim[]; transitions: WorkspaceSuccessionClaim[]; conflicted: boolean }
}

async function applySuccessionTransitions(store: PeerStore, initialCredential: WorkspaceMeshCredential,
  plan: ReturnType<typeof planSuccession>, importedSnapshot: ScopeAuthoritySnapshot | undefined,
  getProfile: () => Promise<LocalProfile>) {
  let credential = initialCredential
  let snapshot = (await store.getWorkspaceAuthority(initialCredential.workspaceId))?.scopeAuthoritySnapshot
  if (plan.conflicted) return { credential, snapshot }
  for (const claim of plan.transitions) {
    const profile = await getProfile()
    if (importedSnapshot) {
      if (!(importedSnapshot.successionTransfers ?? []).some(transfer => transfer.claim.signature === claim.signature))
        throw new Error("Scope authority snapshot is missing an accepted succession transfer")
      const currentScope = snapshot && meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as { controlEpoch: number }
      if (!currentScope) throw new Error("Scope authority snapshot is required for an imported succession")
      snapshot = scopeSnapshotThroughEpoch(importedSnapshot, currentScope.controlEpoch + 1)
      meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now())
    } else if (snapshot) snapshot = appendScopeSuccessionTransfer(snapshot, claim, revocations(credential))
    const adoption = meshRustRuntime().state.planOwnershipAdoption({ credential,
      peers: await store.listPeers(credential.workspaceId), localPersonId: profile.identity.personId,
      verifiedCurrentOwnerEpoch: credential.epoch,
      transition: { kind: "succession", record: claim, claims: plan.claims } }) as {
        previousOwnerPersonId: string; credential: WorkspaceMeshCredential; peers: WorkspacePeerRecord[]
      }
    credential = adoption.credential
    await store.transferWorkspaceCredential(adoption.previousOwnerPersonId, credential, snapshot)
    for (const peer of adoption.peers) await store.upsertPeer(peer)
  }
  return { credential, snapshot }
}

export async function mergeSuccessionState(store: PeerStore, initialCredential: WorkspaceMeshCredential,
  getProfile: () => Promise<LocalProfile>, rawPolicy: WorkspaceSuccessionPolicy | undefined,
  rawVotes: WorkspaceSuccessionVote[], rawClaims: WorkspaceSuccessionClaim[], hasSessions: boolean,
  publish: () => Promise<void>, importedSnapshot?: ScopeAuthoritySnapshot): Promise<WorkspaceMeshCredential> {
  const plan = planSuccession(initialCredential, rawPolicy, rawVotes, rawClaims)
  if (plan.noop) return initialCredential
  const { credential: adopted } = await applySuccessionTransitions(store, initialCredential, plan, importedSnapshot, getProfile)
  let credential = adopted
  const catalogPlan = meshRustRuntime().state.planSuccessionCatalog({ originalCatalog: meshCatalog(initialCredential),
    originalOwnerPersonId: initialCredential.ownerPersonId, credential,
    policy: plan.policy ?? null, votes: plan.votes, claims: plan.claims, updatedAt: new Date().toISOString() })
  if (catalogPlan.persist) {
    credential = catalogPlan.credential as WorkspaceMeshCredential
    await store.putWorkspaceCredential(credential)
    credential = await store.getWorkspaceCredential(credential.workspaceId) ?? credential
  }
  if (catalogPlan.publish && hasSessions) queueMicrotask(() => { void publish() })
  return credential
}

export function planOwnershipMerge(credential: WorkspaceMeshCredential, incoming: WorkspaceOwnershipTransfer[]): OwnershipMergePlan {
  return meshRustRuntime().state.planOwnershipMerge({ workspaceId: credential.workspaceId,
    currentOwner: { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey, certificates: credential.ownerCertificates },
    ownerHistory: ownerAuthorities(credential).slice(1),
    ownerEpoch: Math.max(1, ...[...ownershipTransfers(credential), ...successionClaims(credential)]
      .filter(record => record.payload.toOwnerPersonId === credential.ownerPersonId).map(record => record.payload.epoch)),
    current: ownershipTransfers(credential), incoming, revokedPeople: [...revokedPersonIds(credential)], nowMs: Date.now(),
  }) as OwnershipMergePlan
}

export async function ownershipTransfersWithPending(store: PeerStore, workspaceId: string, raw: WorkspaceOwnershipTransfer[]) {
  const pending = raw.length ? await store.getPendingOwnershipTransfer(workspaceId) : null
  if (!pending) return raw
  const proposal = pending.transfer as WorkspaceOwnershipTransfer
  return raw.some(record => JSON.stringify(record) === JSON.stringify(proposal)) ? raw : [...raw, proposal]
}

async function applyOwnershipSteps(store: PeerStore, credential: WorkspaceMeshCredential, plan: OwnershipMergePlan,
  localPersonId: string) {
  let plannedCredential = credential
  let plannedPeers = await store.listPeers(credential.workspaceId)
  for (const step of plan.steps) {
    const adoption = meshRustRuntime().state.planOwnershipAdoption({ credential: plannedCredential,
      peers: plannedPeers, localPersonId, verifiedCurrentOwnerEpoch: step.previousOwnerEpoch,
      transition: { kind: "transfer", record: step.record, accepted: step.accepted } }) as {
        credential: WorkspaceMeshCredential; peers: Awaited<ReturnType<PeerStore["listPeers"]>>
      }
    plannedCredential = adoption.credential
    plannedPeers = adoption.peers
  }
  return plannedCredential
}

function planIncomingSuccession(workspaceId: string, credential: WorkspaceMeshCredential,
  incomingCatalog: Pick<MeshExport, "successionPolicy" | "successionVotes" | "successionClaims" | "revocations">) {
  const state = meshRustRuntime().state
  const authorities = ownerAuthorities(credential)
  const incomingRevocations = (incomingCatalog.revocations ?? []).filter(record => {
    const authority = authorities.find(owner => owner.personId === record.payload.ownerPersonId)
    if (!authority) return false
    try {
      state.verifyWorkspaceRevocation(record, workspaceId, authority, Date.now())
      return true
    } catch { return false }
  })
  const combinedRevocations = [...revocations(credential), ...incomingRevocations]
  const revokedPeople = new Set([...revokedPersonIds(credential), ...incomingRevocations.map(record => record.payload.personId)])
  return meshRustRuntime().state.planSuccessionMerge({ workspaceId,
    owner: { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey, certificates: credential.ownerCertificates },
    ownerHistory: ownerAuthorities(credential), epoch: credential.epoch,
    currentPolicy: successionPolicy(credential) ?? null, currentVotes: successionVotes(credential),
    currentClaims: successionClaims(credential), incomingPolicy: incomingCatalog.successionPolicy ?? null,
    incomingVotes: incomingCatalog.successionVotes ?? [], incomingClaims: incomingCatalog.successionClaims ?? [],
    revokedPeople: [...revokedPeople], revokedBeforeEpoch: [...new Set(combinedRevocations
      .filter(record => record.payload.epoch < credential.epoch).map(record => record.payload.personId))],
  }, Date.now()) as { transitions: WorkspaceSuccessionClaim[] }
}

function requireScopeSuccessionBridges(snapshot: ScopeAuthoritySnapshot, claims: WorkspaceSuccessionClaim[]) {
  for (const claim of claims) {
    if (!(snapshot.successionTransfers ?? []).some(transfer => transfer.claim.signature === claim.signature))
      throw new Error("Scope authority snapshot is missing an accepted succession transfer")
  }
}

export async function preflightScopeAuthoritySnapshot(store: PeerStore, workspaceId: string, credential: WorkspaceMeshCredential,
  incomingTransfers: WorkspaceOwnershipTransfer[], incoming: ScopeAuthoritySnapshot | undefined,
  incomingCatalog: Pick<MeshExport, "successionPolicy" | "successionVotes" | "successionClaims" | "revocations">,
  localPersonId: string) {
  if (!incoming) return { snapshot: undefined, ownershipPlan: undefined }
  const existingSnapshot = (await store.getWorkspaceAuthority(workspaceId))?.scopeAuthoritySnapshot
  const snapshot = meshRustRuntime().state.mergeScopeAuthoritySnapshots(
    existingSnapshot ?? null, incoming, Date.now()) as ScopeAuthoritySnapshot
  const ownershipPlan = planOwnershipMerge(credential, incomingTransfers)
  const plannedCredential = await applyOwnershipSteps(store, credential, ownershipPlan, localPersonId)
  const ownershipSnapshot = planOwnershipScopeSnapshot(snapshot, existingSnapshot, ownershipPlan, plannedCredential)
  const successionPlan = planIncomingSuccession(workspaceId, plannedCredential, incomingCatalog)
  requireScopeSuccessionBridges(snapshot, successionPlan.transitions)
  const scope = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as {
    scopeId: string; controller: { personId: string; publicKey: string }
  }
  if (scope.scopeId !== workspaceId) throw new Error("Scope authority snapshot belongs to another workspace")
  const succession = successionPlan.transitions.at(-1)?.payload
  const transfer = ownershipPlan.steps.at(-1)?.record.payload
  const owner = succession ? { personId: succession.toOwnerPersonId, publicKey: succession.toOwnerPublicKey }
    : transfer ? { personId: transfer.toOwnerPersonId, publicKey: transfer.toOwnerPublicKey }
      : { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey }
  if (scope.controller.personId !== owner.personId || scope.controller.publicKey !== owner.publicKey)
    throw new Error("Scope authority snapshot does not match the planned workspace owner")
  return { snapshot, ownershipSnapshot, ownershipPlan }
}

function planOwnershipScopeSnapshot(snapshot: ScopeAuthoritySnapshot, existingSnapshot: ScopeAuthoritySnapshot | undefined,
  ownershipPlan: OwnershipMergePlan, credential: WorkspaceMeshCredential) {
  const initialScope = existingSnapshot
    ? meshRustRuntime().state.validateScopeAuthority(existingSnapshot, Date.now()) as { controlEpoch: number }
    : { controlEpoch: ((snapshot.genesis as { payload?: { controlEpoch?: number } }).payload?.controlEpoch ?? 1) }
  const staged = scopeSnapshotThroughEpoch(snapshot, initialScope.controlEpoch + ownershipPlan.steps.length)
  const authority = meshRustRuntime().state.validateScopeAuthority(staged, Date.now()) as {
    controller: { personId: string; publicKey: string }
  }
  if (authority.controller.personId !== credential.ownerPersonId || authority.controller.publicKey !== credential.ownerPublicKey)
    throw new Error("Scope authority snapshot does not match the planned workspace owner")
  return staged
}

export async function persistScopeAuthoritySnapshot(store: PeerStore, workspaceId: string, snapshot: ScopeAuthoritySnapshot | undefined) {
  if (!snapshot) return
  const validated = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as {
    scopeId: string; controller: { personId: string; publicKey: string }
  }
  const authority = await store.getWorkspaceAuthority(workspaceId)
  if (!authority) throw new Error("Workspace authority disappeared during scope authority import")
  if (validated.scopeId !== workspaceId || validated.controller.personId !== authority.ownerPersonId ||
    validated.controller.publicKey !== authority.ownerPublicKey)
    throw new Error("Scope authority snapshot does not match current workspace owner")
  await store.putWorkspaceAuthority({ ...authority, scopeAuthoritySnapshot: snapshot })
}

export async function confirmedOwnershipSnapshot(store: WorkspaceSetStore, workspaceId: string, transfer: WorkspaceOwnershipTransfer,
  scopeAuthoritySnapshot: ScopeAuthoritySnapshot | undefined, exportWorkspace: (workspaceId: string) => Promise<MeshExport>) {
  return workspaceSet({ ...store, readMesh: async id => {
    const mesh = await exportWorkspace(id)
    if (id !== workspaceId) return mesh
    return { ...mesh, ownershipTransfers: [...(mesh.ownershipTransfers ?? []), transfer],
      scopeAuthoritySnapshot: scopeAuthoritySnapshot ?? mesh.scopeAuthoritySnapshot }
  } }, [workspaceId]).snapshot()
}

export async function createOwnershipProposal(profile: LocalProfile, workspaceId: string,
  target: { payload: { personId: string }; publicKey: string; certificates: DeviceCertificate[] }, credential: WorkspaceMeshCredential,
  store: PeerStore, workspaceStore: WorkspaceSetStore) {
  if (!workspaceStore.readAuthorityHeads) throw new Error("Admitted workspace document unavailable for ownership signing")
  const heads = await workspaceStore.readAuthorityHeads(workspaceId)
  const transfer = await createWorkspaceOwnershipTransfer(profile, workspaceId, {
    personId: target.payload.personId, publicKey: target.publicKey, certificates: target.certificates,
  }, heads, credential.epoch + 1, new Date().toISOString(), await meshRecordSigning(profile, credential, { kind: "owner" }, store))
  const snapshot = (await store.getWorkspaceAuthority(workspaceId))?.scopeAuthoritySnapshot
  if (!snapshot) return { transfer, scopeAuthoritySnapshot: undefined }
  const payload = meshRustRuntime().state.createScopeControlTransferPayload({ snapshot,
    toController: { personId: target.payload.personId, publicKey: target.publicKey, certificates: target.certificates } }, Date.now()) as { kind: string }
  const context = await workspaceOwnerSigningContext(profile, workspaceId, payload.kind, {}, async () =>
    await store.getWorkspaceAuthority(workspaceId) ?? await store.getWorkspaceCredential(workspaceId), "scopeId")
  const controlTransfer = await signWithContext(context, payload)
  const scopeAuthoritySnapshot = { ...snapshot, controlTransfers: [...snapshot.controlTransfers, controlTransfer] }
  meshRustRuntime().state.validateScopeAuthority(scopeAuthoritySnapshot, Date.now())
  return { transfer, scopeAuthoritySnapshot }
}

export async function publishConfirmedToSessions(sessions: SessionEntry[], secret: string, snapshot: Uint8Array, message: string) {
  const receipts = await Promise.allSettled(sessions.map(session => publishConfirmedWorkspace(session.connection, secret, snapshot)))
  await Promise.all(sessions.flatMap((session, index) => receipts[index]?.status === "rejected" ? [session.evict(message)] : []))
  return receipts.some(receipt => receipt.status === "fulfilled")
}

export async function awaitOwnerDelivery(sessions: () => SessionEntry[], secret: string, snapshot: Uint8Array, deadline: number) {
  while (true) {
    if (await publishConfirmedToSessions(sessions(), secret, snapshot, "workspace delivery unconfirmed")) return
    if (Date.now() >= deadline) throw new Error("No owner confirmed the workspace before leaving. Keep an owner device online, then retry.")
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}
