import { canonicalizeJson } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { defaultProofStore } from "../domain/proofs"
import { adaptVerifiedWorkspaceAdvertisement } from "@meta-uber/mesh-replication/protocol"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { isDeviceRevoked, isGrantRevoked, ownerAuthorities } from "./durableMeshBase"
import { verifyWorkspaceMemberBundle, type WorkspaceMemberBundle } from "./meshRecords"
import { type PeerStore, type WorkspaceMeshCredential } from "./peerStore"
import { defaultStorage, isWorkspaceAuthorityMutation, type WorkspaceAuthorityMutationContext } from "../storage"

type PeerAdmissionTrace = <T>(phase: string, detail: Record<string, unknown>, operation: () => T | Promise<T>) => Promise<T>
type PeerAdmissionContext = {
  store: PeerStore
  getProfile: () => Promise<{ identity: { personId: string } }>
  trace: PeerAdmissionTrace
  authorityContext: WorkspaceAuthorityMutationContext
}

function peerAuthorizationChanged(previous: Awaited<ReturnType<PeerStore["getPeer"]>>,
  record: { role: string; revokedAt: string | null }, incomingGrant: WorkspaceGrant | undefined): boolean {
  const previousGrant = (previous?.advertisement as { grant?: WorkspaceGrant } | undefined)?.grant
  return !previous || previous.role !== record.role || previous.revokedAt !== record.revokedAt ||
    canonicalizeJson(previousGrant ?? null) !== canonicalizeJson(incomingGrant ?? null)
}

function assertPeerAdmissionContext(workspaceId: string, context: PeerAdmissionContext): void {
  if (!isWorkspaceAuthorityMutation(context.authorityContext, workspaceId, defaultStorage)) {
    throw new Error("Workspace authority mutation context is stale or belongs to another workspace")
  }
}

async function verifyPeerBundle(credential: WorkspaceMeshCredential, raw: WorkspaceMemberBundle, previous: Awaited<ReturnType<PeerStore["getPeer"]>>,
  trace: PeerAdmissionTrace): Promise<{ bundle: WorkspaceMemberBundle; verified: Awaited<ReturnType<typeof verifyWorkspaceMemberBundle>> }> {
  const selected = await trace("peer.grant.plan", {}, () => meshRustRuntime().state.planMemberGrant({
    kind: "prefer", previous: previous?.advertisement ?? null, incoming: raw,
  }))
  const bundle = selected.bundle as WorkspaceMemberBundle
  const verified = await trace("peer.bundle.verify", {}, () => verifyWorkspaceMemberBundle(bundle, {
    workspaceId: credential.workspaceId,
    ownerPersonId: credential.ownerPersonId,
    ownerPublicKey: credential.ownerPublicKey,
    ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
    ownerHistory: ownerAuthorities(credential).slice(1),
  }))
  return { bundle, verified }
}

async function persistPeerLocalGrant<T extends {
  grantId?: string | null; grant?: WorkspaceGrant | null; credential?: WorkspaceMeshCredential | null
}>(local: T, context: PeerAdmissionContext, trace: PeerAdmissionTrace): Promise<void> {
  if (!local.grantId || !local.grant || !local.credential) return
  await context.authorityContext.write(() => trace("peer.local-grant.persist", {},
    () => defaultProofStore.putGrant(local.grantId!, local.grant as WorkspaceGrant)))
  await context.authorityContext.write(() => trace("peer.local-credential.persist", {},
    () => context.store.putWorkspaceCredential(local.credential as WorkspaceMeshCredential)))
}

/** Verify and persist one gossip member while the workspace authority fence is held. */
export async function persistVerifiedPeerBundle(input: {
  credential: WorkspaceMeshCredential
  raw: WorkspaceMemberBundle
  batch?: { index: number; total: number }
  context: PeerAdmissionContext
}): Promise<void> {
  let { credential, raw } = input
  const { context } = input
  assertPeerAdmissionContext(credential.workspaceId, context)
  const peer = { personId: raw.advertisement.payload.personId.slice(0, 8), deviceId: raw.advertisement.payload.deviceId.slice(0, 8),
    ...(input.batch ? { bundleIndex: input.batch.index, bundleCount: input.batch.total } : {}) }
  const trace: PeerAdmissionTrace = (name, detail, operation) => context.trace(name, { ...peer, ...detail }, operation)
  const persist = <T>(operation: () => Promise<T>) => context.authorityContext.write(operation)
  credential = await trace("peer.credential.read", {}, () => context.store.getWorkspaceCredential(credential.workspaceId)) ?? credential
  const previous = await trace("peer.previous.read", {}, () => context.store.getPeer(credential.workspaceId, raw.advertisement.payload.deviceId))
  const planned = await verifyPeerBundle(credential, raw, previous, trace)
  raw = planned.bundle
  const { verified } = planned
  const ownerCertificates = await trace("peer.certificates.merge", {}, () => [...new Map([
    ...credential.ownerCertificates as DeviceCertificate[], ...(verified.ownerCertificates ?? []),
  ].map(certificate => [certificate.signature, certificate])).values()])
  if (ownerCertificates.length > credential.ownerCertificates.length) {
    await persist(() => trace("peer.certificates.persist", {}, () => context.store.putWorkspaceCredential({ ...credential,
      ownerCertificates, updatedAt: new Date().toISOString() })))
  }
  const payload = verified.advertisement.payload
  if (await trace("peer.device-revocation.check", {}, () => isDeviceRevoked(credential, payload.personId, payload.deviceId))) {
    throw new Error("Device access revoked")
  }
  const route = await trace("peer.route.adapt", {}, () => adaptVerifiedWorkspaceAdvertisement(verified.advertisement))
  if (await trace("peer.grant-revocation.check", {}, () => isGrantRevoked(credential, payload.personId, raw.grant as WorkspaceGrant | undefined))) {
    throw new Error("Workspace member is revoked")
  }
  const profile = await trace("peer.profile.read", {}, () => context.getProfile())
  const local = await trace("peer.local-grant.plan", {}, () => meshRustRuntime().state.planMemberGrant({
    kind: "persistLocal", credential, localPersonId: profile.identity.personId, grant: raw.grant ?? null,
    ownerCertificates, updatedAt: new Date().toISOString(),
  }))
  await persistPeerLocalGrant(local, context, trace)
  const record = await trace("peer.record.build", {}, () => ({
    workspaceId: route.scopeId, personId: route.personId, deviceId: route.deviceId, instanceId: route.instanceId,
    endpoint: route.endpoint, transportSecret: credential.transportSecret, role: verified.role, lastSeen: route.issuedAt,
    revokedAt: null, advertisement: raw,
  }))
  const authorizationChanged = peerAuthorizationChanged(previous, record, raw.grant)
  const upsert = () => trace("peer.upsert", {}, () => context.store.upsertPeer(record))
  if (authorizationChanged) await persist(upsert)
  else await upsert()
}
