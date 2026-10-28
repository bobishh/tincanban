import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import type { KeeperIntegrationReference } from "../domain/model"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { keeperIntegrationReferences, ownerKeepers, mayOfferFutureKeeperWorkspace, type OwnerKeeper } from "./ownerKeeper"
import { defaultProofStore, createWorkspaceGrant } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { workspaceOwnerSigningContext } from "./workspaceOwnerSigning"
import type { PeerStore, WorkspaceAuthorityRecord, WorkspaceMeshCredential } from "./peerStore"
import type { SyncConnection } from "./transport"
import type { WorkspaceSetStore, OwnerWorkspaceOfferFrame } from "./workspaceSet"
import { registerOwnerOfferProofs, publishOwnerWorkspaceOffer, OwnerOfferAccessDenied } from "./ownerOfferProofs"
import { z } from "zod"

export const ownerWorkspaceOfferSchema = z.object({
  version: z.literal(1),
  workspaceId: z.string().min(1),
  envelope: z.unknown(),
  workspace: z.unknown(),
}).passthrough()

function selectOwnerKeeperOfferReference(references: KeeperIntegrationReference[]) {
  const live = references.filter(item => item.state !== "removed")
  if (live.length === 1) return live[0]
  return live.length === 0 && references.length === 0 ? undefined : null
}

/** Returns a real signed grant only when this identity still verifies for it. */
export async function ownerKeeperOfferPolicy(profile: LocalProfile, remotePersonId: string): Promise<{ allowed: boolean; keeper?: OwnerKeeper }> {
  if (remotePersonId === profile.identity.personId) return { allowed: true }
  let keeper = (await ownerKeepers(profile.identity.personId)).find(item => item.personId === remotePersonId)
  let references
  try {
    const { integrations } = await keeperIntegrationReferences()
    references = Object.values(integrations).filter(item => item.servicePersonId === remotePersonId)
  } catch {
    return { allowed: false }
  }
  // Integration revisions are scoped to integrationId. Never use one service's
  // revision values to choose between distinct legacy/canonical records.
  const reference = selectOwnerKeeperOfferReference(references)
  if (reference === null) return { allowed: false }
  // A durable ref with no live integration still outranks the legacy cache.
  if (reference && reference.state !== "active") return { allowed: false }
  // Do not mint owner grants against committed policy while a settings CAS is unresolved.
  if (reference?.pendingSettings || reference?.pendingRemoval) return { allowed: false }
  if (reference) keeper = { personId: remotePersonId, role: "editor", details: {
    boardIds: reference.workspaceIds,
    futureBoards: reference.futureBoards,
    futureBoardBaselineIds: reference.futureBoardBaselineIds,
    integrationId: reference.integrationId,
    removalPending: Boolean(reference.pendingRemoval),
  } }
  if (!keeper || keeper.details?.removalPending) return { allowed: false }
  return { allowed: true, keeper }
}

type OfferHost = {
  getProfile: () => Promise<LocalProfile>
  store: Pick<PeerStore, "getWorkspaceCredential" | "getWorkspaceAuthority">
  workspaceStore: WorkspaceSetStore
  pending: Map<string, Promise<void>>
  ownedIds: (profile: LocalProfile) => Promise<string[]>
  prepare: (ids: string[], profile: LocalProfile) => Promise<void>
  encode: (id: string) => Promise<Uint8Array>
  nextAccessEpoch: (id: string) => Promise<number>
}
type OfferTarget = { connection: SyncConnection; secret: string; remoteWorkspaceIds: unknown;
  remotePersonId: string; remoteDeviceId: string; frame?: OwnerWorkspaceOfferFrame; onlyWorkspaceIds?: string[] }

/** The authenticated recipient's current board rights govern every outgoing byte. */
async function requireOfferAccess(host: OfferHost, target: OfferTarget, owner: LocalProfile, workspaceId: string, keeper?: OwnerKeeper) {
  const profile = await host.getProfile()
  const signer = [profile.identity.personId, profile.identity.publicKey, profile.device.deviceId]
  const expectedSigner = [owner.identity.personId, owner.identity.publicKey, owner.device.deviceId]
  if (canonicalizeJson(signer) !== canonicalizeJson(expectedSigner) || !target.remoteDeviceId) throw new OwnerOfferAccessDenied()
  const policy = await ownerKeeperOfferPolicy(profile, target.remotePersonId)
  if (!policy.allowed || canonicalizeJson(policy.keeper ?? null) !== canonicalizeJson(keeper ?? null)) throw new OwnerOfferAccessDenied()
  const [credential, authority] = await Promise.all([
    host.store.getWorkspaceCredential(workspaceId), host.store.getWorkspaceAuthority(workspaceId),
  ])
  if (!credential || credential.workspaceId !== workspaceId) throw new OwnerOfferAccessDenied()
  assertOfferBoardAccess(credential, authority, profile, target)
}

function assertOfferBoardAccess(credential: WorkspaceMeshCredential, authority: WorkspaceAuthorityRecord | null,
  profile: LocalProfile, target: OfferTarget) {
  const state = meshRustRuntime().state
  const binding = canonicalizeJson([credential.workspaceId, profile.identity.personId, profile.identity.publicKey, credential.epoch])
  for (const current of [credential, ...(authority ? [authority] : [])]) {
    if (canonicalizeJson([current.workspaceId, current.ownerPersonId, current.ownerPublicKey, current.epoch]) !== binding ||
        state.hasAuthorityConflict(current)) throw new OwnerOfferAccessDenied()
    if (state.isDeviceRevoked(current, target.remotePersonId, target.remoteDeviceId) ||
        state.isGrantRevoked(current, target.remotePersonId, null) || state.hasLeftWorkspace(current, target.remotePersonId, null) ||
        state.isDeviceRevoked(current, profile.identity.personId, profile.device.deviceId) ||
        state.isGrantRevoked(current, profile.identity.personId, credential.localGrant ?? null) ||
        state.hasLeftWorkspace(current, profile.identity.personId, credential.localGrant ?? null)) throw new OwnerOfferAccessDenied()
  }
}

export async function offerOwnerWorkspaces(host: OfferHost, target: OfferTarget): Promise<void> {
  if (!target.frame) return
  const profile = await host.getProfile(), policy = await ownerKeeperOfferPolicy(profile, target.remotePersonId)
  if (!policy.allowed) return
  const keeper = policy.keeper
  const ownedIds = await host.ownedIds(profile)
  await host.prepare(ownedIds, profile)
  const missing = meshRustRuntime().state.missingOwnerWorkspaces(ownedIds, target.remoteWorkspaceIds)
    .filter(id => !target.onlyWorkspaceIds || target.onlyWorkspaceIds.includes(id))
    .filter(id => !keeper || keeper.details?.boardIds.includes(id) || mayOfferFutureKeeperWorkspace(keeper.details, id))
  for (const workspaceId of missing) {
    const ensureCurrent = () => requireOfferAccess(host, target, profile, workspaceId, keeper)
    const key = `${target.remotePersonId}\0${target.remoteDeviceId}\0${workspaceId}`
    try {
      await ensureCurrent()
      const pending = host.pending.get(key)
      if (pending) { await pending; continue }
      const offer = (async () => {
        let bytes = await host.encode(workspaceId)
        await ensureCurrent()
        if (keeper) {
          const issued = await defaultProofStore.listGrants(workspaceId)
          let grant = issued.find(record => record.payload.personId === target.remotePersonId && record.payload.role === keeper.role)
          if (!grant) {
            const accessEpoch = await host.nextAccessEpoch(workspaceId)
            const context = await workspaceOwnerSigningContext(profile, workspaceId, "workspace-grant",
              { personId: target.remotePersonId, role: keeper.role, accessEpoch }, async () =>
                await host.store.getWorkspaceAuthority(workspaceId) ?? await host.store.getWorkspaceCredential(workspaceId))
            await ensureCurrent()
            grant = await createWorkspaceGrant(profile, workspaceId, target.remotePersonId, keeper.role, accessEpoch, context)
            await defaultStorage.withWorkspaceAuthorityMutation(workspaceId, async context => {
              await ensureCurrent()
              await context.write(() => defaultProofStore.putGrant(grant!.payload.grantId, grant!))
            })
          }
          const value = z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder().decode(bytes)))
          bytes = new TextEncoder().encode(JSON.stringify({ ...value, grant, controllerPersonId: profile.identity.personId }))
        }
        await ensureCurrent()
        const release = await registerOwnerOfferProofs(target.connection, target.secret, bytes, host.workspaceStore, ensureCurrent)
        try { await publishOwnerWorkspaceOffer(target.connection, target.secret, bytes, target.frame!, ensureCurrent) }
        finally { release() }
      })()
      host.pending.set(key, offer)
      try { await offer } finally { if (host.pending.get(key) === offer) host.pending.delete(key) }
    } catch (error) { if (!(error instanceof OwnerOfferAccessDenied)) throw error }
  }
}
