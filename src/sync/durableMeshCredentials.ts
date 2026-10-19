import { type LocalProfile, toBase64Url } from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { defaultProofStore, createWorkspaceGrant } from "../domain/proofs"
import { mayOfferFutureKeeperWorkspace, saveOwnerKeeper } from "./ownerKeeper"
import { createPairingSecret} from "@meta-uber/mesh-pairing"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { createPeerAdvertisement, verifyWorkspaceMemberBundle,
  type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim,
  type WorkspaceDeparture, type WorkspaceDeviceRevocation } from "./meshRecords"
import { type PeerStore, type WorkspaceMeshCredential} from "./peerStore"
import type { SyncConnection} from "./transport"
import { workspaceSet, publishOwnerWorkspaceOffer} from "./workspaceSet"
import { exportWorkspaceProofs } from "./workspaceProofTransfer"
import { registerOwnerOfferProofs } from "./ownerOfferProofs"
import { departures, hasLeftWorkspace, deviceRevocations, isDeviceRevoked, isGrantRevoked, uniqueCertificates, isEnvelope, revocations, ownershipTransfers, successionPolicy, successionVotes, successionClaims, ownerAuthorities,
  type MeshExport, type MeshWorkspaceEnvelope } from "./durableMeshBase"
import { DurableMeshBase } from "./durableMeshBase"
import { defaultStorage, type WorkspaceAuthorityMutationContext } from "../storage"
import { workspaceOwnerSigningContext } from "./workspaceOwnerSigning"
import { workspaceRecordSigning } from "./meshRecordSigning"
import { ownerKeeperOfferPolicy, ownerWorkspaceOfferSchema } from "./durableMeshOwnerOfferPolicy"
export { ownerKeeperOfferPolicy } from "./durableMeshOwnerOfferPolicy"
import { z } from "zod"

export type KeeperGrantScopeProof = { workspaceId: string; document: string; authorizationBundle: unknown; grant: WorkspaceGrant }

function captureAcceptedGuestGrants(workspaceIds: string[], personId: string, acceptedGrants?: WorkspaceGrant[]): Map<string, WorkspaceGrant> | undefined {
  if (acceptedGrants === undefined) return undefined
  const uniqueIds = new Set(workspaceIds)
  if (uniqueIds.size !== workspaceIds.length) throw new Error("Workspace access authorization changed")
  const grants = new Map<string, WorkspaceGrant>()
  for (const grant of acceptedGrants) {
    const workspaceId = grant?.payload?.workspaceId
    if (grant?.payload?.personId !== personId || !workspaceIds.includes(workspaceId) || grants.has(workspaceId)) {
      throw new Error("Workspace access authorization changed")
    }
    grants.set(workspaceId, grant)
  }
  if (grants.size !== uniqueIds.size) throw new Error("Workspace access authorization changed")
  return grants
}

async function verifyGuestDeviceAdvertisement(raw: unknown, workspaceIds: string[], personId: string,
  grants: Map<string, WorkspaceGrant> | undefined, seen: Set<string>, selectedDevice: string | undefined,
  store: PeerStore): Promise<string> {
  const verified = await verifyWorkspaceMemberBundle(raw)
  const peer = verified.advertisement.payload
  if (peer.personId !== personId || !workspaceIds.includes(peer.workspaceId)) throw new Error("Guest device does not match invitation")
  if (seen.has(peer.workspaceId) || selectedDevice !== undefined && selectedDevice !== peer.deviceId) {
    throw new Error("Invitation must be bound to one verified guest device across its workspace set")
  }
  seen.add(peer.workspaceId)
  const credential = await store.getWorkspaceCredential(peer.workspaceId)
  const grant = grants?.get(peer.workspaceId)
  if (credential && isDeviceRevoked(credential, peer.personId, peer.deviceId)) throw new Error("Device access revoked")
  if (credential && grant && (isGrantRevoked(credential, personId, grant) || hasLeftWorkspace(credential, personId, grant))) {
    throw new Error("Workspace access revoked")
  }
  if (grants && !grant) throw new Error("Workspace access authorization changed")
  return peer.deviceId
}

export abstract class DurableMeshCredentials extends DurableMeshBase {
  private readonly ownerWorkspaceOffers = new Map<string, Promise<void>>()
  protected abstract mergeDepartures(credential: WorkspaceMeshCredential, records: WorkspaceDeparture[], disconnect?: boolean): Promise<void>
  protected abstract mergeDeviceRevocations(credential: WorkspaceMeshCredential, records: WorkspaceDeviceRevocation[]): Promise<void>

  protected abstract refreshOwnBundle(credential: WorkspaceMeshCredential, profile: LocalProfile,
    endpoint: string, certificates: DeviceCertificate[]): Promise<WorkspaceMemberBundle | undefined>
  protected abstract mergeRevocations(credential: WorkspaceMeshCredential, raw: unknown[], disconnect?: boolean,
    authorityContext?: WorkspaceAuthorityMutationContext): Promise<void>
  protected abstract mergePeerBundles(credential: WorkspaceMeshCredential, bundles: WorkspaceMemberBundle[]): Promise<void>
  protected abstract putVerifiedBundle(credential: WorkspaceMeshCredential, raw: WorkspaceMemberBundle): Promise<void>
  protected abstract mergeOwnershipTransfers(credential: WorkspaceMeshCredential, raw: WorkspaceOwnershipTransfer[]): Promise<WorkspaceMeshCredential>
  protected abstract mergeSuccessionState(credential: WorkspaceMeshCredential, policy: WorkspaceSuccessionPolicy | undefined, votes: WorkspaceSuccessionVote[], claims: WorkspaceSuccessionClaim[]): Promise<WorkspaceMeshCredential>
  protected abstract refreshSuccessionPolicy(workspaceId: string, authorityContext?: WorkspaceAuthorityMutationContext): Promise<void>
  protected async refreshOwnerCertificates(credential: WorkspaceMeshCredential, profile: LocalProfile,
    certificates: DeviceCertificate[]): Promise<WorkspaceMeshCredential> {
    const next = meshRustRuntime().state.planOwnerCertificateRefresh(credential,
      profile.identity.personId, certificates, new Date().toISOString()) as WorkspaceMeshCredential | null
    if (!next) return credential
    await defaultStorage.withWorkspaceAuthorityMutation(credential.workspaceId,
      context => context.write(() => this.store.putWorkspaceCredential(next)))
    const committed = await this.store.getWorkspaceCredential(credential.workspaceId)
    if (!committed) throw new Error("Workspace credential disappeared during certificate refresh")
    return committed
  }


  protected async credentialBelongsToProfile(credential: WorkspaceMeshCredential, profile: LocalProfile): Promise<boolean> {
    if (hasLeftWorkspace(credential, profile.identity.personId, credential.localGrant as WorkspaceGrant | undefined) || isDeviceRevoked(credential, profile.identity.personId, profile.device.deviceId)) return false
    return meshRustRuntime().state.credentialBelongsToProfile(credential,
      profile.identity.personId, profile.identity.publicKey)
  }

  protected async activeCredentialsForProfile(credentials: WorkspaceMeshCredential[], profile: LocalProfile) {
    const plan = meshRustRuntime().state.partitionCredentials({ credentials,
      personId: profile.identity.personId, publicKey: profile.identity.publicKey,
      deviceId: profile.device.deviceId })
    const active = plan.activeIndices.map(index => credentials[index]!)
    const mismatched = plan.mismatchedIndices.map(index => credentials[index]!)
    for (const credential of mismatched) {
      // A transient or concurrent identity bootstrap must not erase durable mesh trust.
      // Enrollment replaces stale credentials explicitly after mutual approval.
      this.trace("credential.identity-mismatch", { workspaceId: credential.workspaceId }, "warn")
    }
    if (mismatched.length && active.length === 0) {
      this.report("Mesh identity", new Error("Stored mesh trust belongs to another local identity. Re-enroll this device."))
    }
    // Keep the record for recovery, but never let it reach the dial scheduler.
    this.activeWorkspaceIds = new Set(active.map(credential => credential.workspaceId))
    return active
  }

  async ensureOwnerWorkspaces(workspaceIds: string[], endpoint: string, profile: LocalProfile): Promise<void> {
    await this.acquireInstance()
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    for (const workspaceId of workspaceIds) {
      const credential = await this.ensureOwnerCredential(
        workspaceId,
        profile,
        certificates,
      )
      await this.refreshOwnBundle(credential, profile, endpoint, certificates)
    }
    await this.notify()
  }

  private async ensureOwnerCredential(workspaceId: string, profile: LocalProfile, certificates: DeviceCertificate[]): Promise<WorkspaceMeshCredential> {
    const existing = await this.store.getWorkspaceCredential(workspaceId)
    const action = meshRustRuntime().state.decideOwnerCredential(existing?.ownerPersonId, profile.identity.personId)
    if (action === "refresh") return this.refreshOwnerCertificates(existing!, profile, certificates)
    if (action !== "create") throw new Error("Invalid owner credential decision")
    const credential: WorkspaceMeshCredential = { version: 1, workspaceId, ownerPersonId: profile.identity.personId,
      ownerPublicKey: profile.identity.publicKey, ownerCertificates: certificates, transportSecret: createPairingSecret(),
      epoch: 1, updatedAt: new Date().toISOString() }
    await defaultStorage.withWorkspaceAuthorityMutation(workspaceId,
      context => context.write(() => this.store.putWorkspaceCredential(credential)))
    return credential
  }

  protected async ownerWorkspaceIds(profile: LocalProfile) {
    return meshRustRuntime().state.ownedWorkspaceIds(await this.store.listWorkspaceCredentials(),
      profile.identity.personId, profile.identity.publicKey)
  }

  async connectOwnerKeeper(personId: string, role: "visitor" | "editor") {
    const profile = await this.options.getProfile()
    await saveOwnerKeeper(profile.identity.personId, { personId, role })
  }

  /** Capture owner-signed post-revocation evidence for Rusty withdrawal completion. */
  async captureRevocationCompletionScopes(workspaceIds: string[], targetPersonId: string) {
    const profile = await this.options.getProfile()
    const ids = [...new Set(workspaceIds)].sort()
    if (!ids.length || ids.length !== workspaceIds.length || targetPersonId === profile.identity.personId) {
      throw new Error("Keeper revocation scope set is invalid.")
    }
    const scopes = []
    for (const workspaceId of ids) {
      const credential = await this.store.getWorkspaceCredential(workspaceId)
      if (!credential || credential.ownerPersonId !== profile.identity.personId
        || credential.ownerPublicKey !== profile.identity.publicKey) {
        throw new Error("Current owner proof is unavailable for a selected keeper board.")
      }
      const signedRevocations = revocations(credential).filter(item => item.payload.personId === targetPersonId)
      if (!signedRevocations.length) throw new Error("Signed keeper revocation is not saved for every selected board.")
      const peers = await this.store.listPeers(workspaceId)
      for (const peer of peers.filter(item => item.personId === targetPersonId && !item.revokedAt)) {
        const grant = (peer.advertisement as WorkspaceMemberBundle | undefined)?.grant
        if (!grant || !isGrantRevoked(credential, targetPersonId, grant)) {
          throw new Error("Keeper still has an active board grant. Retry local revocation before completing cancellation.")
        }
      }
      const document = await this.options.workspaceStore.read(workspaceId)
      const readAuthorization = this.options.workspaceStore.readAuthorization
      if (!readAuthorization) throw new Error("Signed board authorization proof is unavailable.")
      const authorization = await readAuthorization(document, workspaceId)
      scopes.push({ workspaceId, document: toBase64Url(document),
        authorizationBundle: exportWorkspaceProofs(document, authorization) })
    }
    return scopes
  }

  /** Capture original owner-signed grants before first withdrawal; callers persist exact bytes by operation id. */
  async captureKeeperGrantScopeProofs(workspaceIds: string[], targetPersonId: string): Promise<KeeperGrantScopeProof[]> {
    const profile = await this.options.getProfile()
    const ids = [...new Set(workspaceIds)].sort()
    if (!ids.length || ids.length !== workspaceIds.length || targetPersonId === profile.identity.personId) {
      throw new Error("Keeper grant proof scope set is invalid.")
    }
    const scopes: KeeperGrantScopeProof[] = []
    for (const workspaceId of ids) {
      const credential = await this.store.getWorkspaceCredential(workspaceId)
      if (!credential || credential.ownerPersonId !== profile.identity.personId
        || credential.ownerPublicKey !== profile.identity.publicKey) {
        throw new Error("Current owner proof is unavailable for a selected keeper board.")
      }
      const grants = await defaultProofStore.listGrants(workspaceId)
      const candidates = grants.filter(grant => grant.payload.workspaceId === workspaceId
        && grant.payload.personId === targetPersonId && grant.payload.role === "editor")
      const peers = await this.store.listPeers(workspaceId)
      const peerGrantIds = new Set(peers.filter(peer => peer.personId === targetPersonId && !peer.revokedAt)
        .map(peer => (peer.advertisement as WorkspaceMemberBundle | undefined)?.grant?.payload.grantId)
        .filter((id): id is string => typeof id === "string"))
      const current = candidates.filter(grant => peerGrantIds.has(grant.payload.grantId))
      const pool = current.length ? current : candidates
      const latestEpoch = Math.max(0, ...pool.map(grant => grant.payload.accessEpoch ?? 1))
      const latest = pool.filter(grant => (grant.payload.accessEpoch ?? 1) === latestEpoch)
      if (!pool.length) continue
      if (latestEpoch < 1 || latest.length !== 1) throw new Error("A unique owner-signed keeper grant is unavailable for this board.")
      const document = await this.options.workspaceStore.read(workspaceId)
      const readAuthorization = this.options.workspaceStore.readAuthorization
      if (!readAuthorization) throw new Error("Signed board authorization proof is unavailable.")
      const authorization = await readAuthorization(document, workspaceId)
      scopes.push({ workspaceId, document: toBase64Url(document),
        authorizationBundle: exportWorkspaceProofs(document, authorization), grant: latest[0]! })
    }
    return scopes
  }

  async addOwnerWorkspace(workspaceId: string): Promise<void> {
    const profile = await this.options.getProfile()
    const certificates = uniqueCertificates(
      profile,
      await defaultProofStore.listCertificates(),
    )
    const credential = await this.ensureOwnerCredential(
      workspaceId,
      profile,
      certificates,
    )
    this.activeWorkspaceIds?.add(workspaceId)
    if (this.node)
      await this.refreshOwnBundle(
        credential,
        profile,
        this.node.endpointId,
        certificates,
      )
    // Resume existing peer connections for this workspace. A local-only owner
    // credential does not require transport; invitations start their own node.
    await this.start()
    await this.notify()
    void Promise.allSettled([...this.sessions.values()].map(async entry => {
      if (!entry.ownerWorkspaceOfferFrame) return
      const credential = await this.store.getWorkspaceCredential(entry.workspaceId)
      if (!credential) return
      await this.offerMissingOwnerWorkspaces(entry.connection, credential.transportSecret, [], entry.remotePersonId, entry.ownerWorkspaceOfferFrame, [workspaceId])
    }))
  }

  protected async encodeOwnerWorkspaceOffer(workspaceId: string) {
    const [envelope] = await this.invitationPayload([workspaceId])
    const workspaces = z.array(z.unknown()).length(1).parse(JSON.parse(new TextDecoder().decode(
      await workspaceSet(this.options.workspaceStore, [workspaceId]).snapshot(),
    )))
    const [workspace] = workspaces
    return new TextEncoder().encode(JSON.stringify({ version: 1, workspaceId, envelope, workspace }))
  }

  protected async receiveOwnerWorkspaceOffer(bytes: Uint8Array, remotePersonId: string,
    connection: SyncConnection, secret: string) {
    const profile = await this.options.getProfile()
    const value = ownerWorkspaceOfferSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
    if (!isEnvelope(value.envelope)) throw new Error("Invalid owner workspace offer")
    const workspaceId = meshRustRuntime().state.validateOwnerWorkspaceOffer(value, remotePersonId, profile.identity.personId)
    await this.validateInvitation([value.envelope], [workspaceId], profile, [])
    // Persist the signed document before activating its credential. Otherwise
    // an interrupted offer leaves durable mesh retrying a workspace which has
    // no local document yet.
    const replica = workspaceSet(this.options.workspaceStore, [workspaceId])
    const snapshot = new TextEncoder().encode(JSON.stringify([value.workspace]))
    await replica.receive(await replica.resolveProofs(snapshot, connection, secret), false)
    await this.receiveInvitation([value.envelope], [workspaceId], profile, [])
    if (!this.node) throw new Error("Workspace mesh is unavailable")
    await this.ensureOwnerWorkspaces([workspaceId], this.node.endpointId, profile)
    const recordVerifiedOwnerWorkspace = this.options.workspaceStore.recordVerifiedOwnerWorkspace
    if (!recordVerifiedOwnerWorkspace)
      throw new Error("Verified owner workspace could not be added to the local catalog")
    await recordVerifiedOwnerWorkspace(workspaceId)
  }

  protected async offerMissingOwnerWorkspaces(connection: SyncConnection, secret: string,
    remoteWorkspaceIds: unknown, remotePersonId: string,
    ownerWorkspaceOfferFrame: "mesh-owner-workspace-offer" | "mesh-owner-workspace-offer-page-v1" | undefined,
    onlyWorkspaceIds?: string[]) {
    const profile = await this.options.getProfile()
    if (!ownerWorkspaceOfferFrame) return
    const policy = await ownerKeeperOfferPolicy(profile, remotePersonId)
    if (!policy.allowed) return
    const keeper = policy.keeper
    const ownedIds = this.options.getOwnedWorkspaceIds ? await this.options.getOwnedWorkspaceIds() : await this.ownerWorkspaceIds(profile)
    if (this.node) await this.ensureOwnerWorkspaces(ownedIds, this.node.endpointId, profile)
    const missing = meshRustRuntime().state.missingOwnerWorkspaces(ownedIds, remoteWorkspaceIds)
      .filter(workspaceId => !onlyWorkspaceIds || onlyWorkspaceIds.includes(workspaceId))
      .filter(workspaceId => !keeper || keeper.details?.boardIds.includes(workspaceId)
        || mayOfferFutureKeeperWorkspace(keeper.details, workspaceId))
    for (const workspaceId of missing) {
      const key = `${remotePersonId}\0${workspaceId}`
      const pending = this.ownerWorkspaceOffers.get(key)
      if (pending) {
        await pending
        continue
      }
      const offerPromise = (async () => {
        let offer = await this.encodeOwnerWorkspaceOffer(workspaceId)
        if (keeper) {
          const credential = await this.store.getWorkspaceCredential(workspaceId)
          if (credential?.ownerPersonId !== profile.identity.personId) return
          // Existing revocation/departure always wins over the future-board policy.
          if (hasLeftWorkspace(credential, remotePersonId) || revocations(credential).some(record => record.payload.personId === remotePersonId)) return
          const issued = await defaultProofStore.listGrants(workspaceId)
          let grant = issued.find(record => record.payload.personId === remotePersonId && record.payload.role === keeper.role)
          if (!grant) {
            const accessEpoch = await this.nextAccessEpoch(workspaceId)
            const context = await workspaceOwnerSigningContext(profile, workspaceId, "workspace-grant",
              { personId: remotePersonId, role: keeper.role, accessEpoch }, async () =>
                await this.store.getWorkspaceAuthority(workspaceId) ?? await this.store.getWorkspaceCredential(workspaceId))
            grant = await createWorkspaceGrant(profile, workspaceId, remotePersonId, keeper.role, accessEpoch, context)
            await defaultStorage.withWorkspaceAuthorityMutation(workspaceId,
              context => context.write(() => defaultProofStore.putGrant(grant!.payload.grantId, grant!)))
          }
          const value = z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder().decode(offer)))
          offer = new TextEncoder().encode(JSON.stringify({ ...value, grant, controllerPersonId: profile.identity.personId }))
        }
        const release = await registerOwnerOfferProofs(connection, secret, offer, this.options.workspaceStore)
        try { await publishOwnerWorkspaceOffer(connection, secret, offer, ownerWorkspaceOfferFrame) }
        finally { release() }
      })()
      this.ownerWorkspaceOffers.set(key, offerPromise)
      try { await offerPromise } finally {
        if (this.ownerWorkspaceOffers.get(key) === offerPromise) this.ownerWorkspaceOffers.delete(key)
      }
    }
  }

  async createGuestAdvertisements(workspaceIds: string[], endpoint: string, profile: LocalProfile): Promise<WorkspaceMemberBundle[]> {
    await this.acquireInstance()
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    return Promise.all(workspaceIds.map(async workspaceId => createPeerAdvertisement(profile, workspaceId, endpoint,
      { certificates, instanceId: this.instanceId, signing: await workspaceRecordSigning(profile, workspaceId,
        async () => "unjoined-route", ["peer-advertisement"]) })))
  }

  async forgetEnrolledDevice(workspaceIds: string[], deviceId: string): Promise<void> {
    for (const workspaceId of new Set(workspaceIds)) {
      for (const [key, entry] of [...this.sessions]) {
        if (entry.workspaceId !== workspaceId || entry.deviceId !== deviceId) continue
        this.runtime().clearRouteAttempt(key)
        this.clearRouteReconnect(key)
        await entry.evict("device forgotten")
      }
      await defaultStorage.withWorkspaceAuthorityMutation(workspaceId,
        context => context.write(() => this.store.removePeer(workspaceId, deviceId)))
    }
  }

  async knowsWorkspaceIssuer(workspaceIds: string[], personId: string, deviceId: string): Promise<boolean> {
    const profile = await this.options.getProfile()
    const workspaces = await Promise.all(workspaceIds.map(async id => ({
      credential: await this.store.getWorkspaceCredential(id), issuer: await this.store.getPeer(id, deviceId),
    })))
    return meshRustRuntime().state.knowsWorkspaceIssuer(workspaces, personId,
      profile.identity.personId, profile.device.deviceId)
  }

  async checkGuestDevices(workspaceIds: string[], personId: string, rawBundles: unknown,
    acceptedGrants?: WorkspaceGrant[]): Promise<string> {
    if (!Array.isArray(rawBundles)) throw new Error("Missing guest device advertisements")
    const grantsByWorkspace = captureAcceptedGuestGrants(workspaceIds, personId, acceptedGrants)
    const seenWorkspaces = new Set<string>()
    let deviceId: string | undefined
    for (const raw of rawBundles) {
      deviceId = await verifyGuestDeviceAdvertisement(raw, workspaceIds, personId, grantsByWorkspace, seenWorkspaces, deviceId, this.store)
    }
    if (!deviceId || seenWorkspaces.size !== new Set(workspaceIds).size) throw new Error("Guest device advertisements do not cover the invitation")
    return deviceId
  }

  async acceptGuest(workspaceIds: string[], rawBundles: unknown, grants: WorkspaceGrant[]): Promise<void> {
    const credentials = await Promise.all(workspaceIds.map(id => this.store.getWorkspaceCredential(id)))
    const entries = meshRustRuntime().state.planGuestAdvertisements({ raw: rawBundles, workspaceIds,
      grantWorkspaceIds: grants.map(grant => grant.payload.workspaceId),
      credentialPresent: credentials.map(Boolean) })
    for (const entry of entries) {
      const credential = credentials[workspaceIds.indexOf(entry.workspaceId)]!
      const raw = (rawBundles as WorkspaceMemberBundle[])[entry.bundleIndex]!
      const grant = grants[entry.grantIndex]!
      await this.putVerifiedBundle(credential, { ...raw, grant,
        ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as DeviceCertificate[] })
      await this.refreshSuccessionPolicy(entry.workspaceId)
    }
    await this.notify()
  }

  async invitationPayload(workspaceIds: string[]): Promise<MeshWorkspaceEnvelope[]> {
    const envelopes: MeshWorkspaceEnvelope[] = []
    for (const workspaceId of workspaceIds) {
      const credential = await this.store.getWorkspaceCredential(workspaceId)
      if (!credential) throw new Error("Missing workspace mesh credential")
      const peers = (await this.peerInstances(workspaceId)).filter(peer => !peer.revokedAt && peer.advertisement)
        .map(peer => peer.advertisement as WorkspaceMemberBundle)
      const authority = await this.store.getWorkspaceAuthority(workspaceId)
      envelopes.push({ version: 1, workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
        ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates,
        transportSecret: credential.transportSecret, epoch: credential.epoch, peers,
        revocations: revocations(credential), deviceRevocations: deviceRevocations(credential), departures: departures(credential),
        ownerHistory: ownerAuthorities(credential).slice(1), ownershipTransfers: ownershipTransfers(credential),
        successionPolicy: successionPolicy(credential), successionVotes: successionVotes(credential), successionClaims: successionClaims(credential),
        scopeAuthoritySnapshot: authority?.scopeAuthoritySnapshot })
    }
    return envelopes
  }

  /** Returns a real signed grant only when this identity still verifies for it. */
  async enrollmentGrant(workspaceId: string, profile: LocalProfile): Promise<WorkspaceGrant | undefined> {
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    if (!credential || credential.ownerPersonId === profile.identity.personId) return undefined
    if (!await this.credentialBelongsToProfile(credential, profile)) return undefined
    return credential.localGrant as WorkspaceGrant | undefined
  }

  protected async verifyInvitationAuthority(workspaceId: string, envelope: MeshWorkspaceEnvelope, profile: LocalProfile,
    localGrant: WorkspaceGrant | undefined): Promise<DeviceCertificate[]> {
    const existing = await this.store.getWorkspaceCredential(workspaceId)
    const authority = await this.store.getWorkspaceAuthority(workspaceId)
    const credential = meshRustRuntime().state.planInvitationCredential({ workspaceId, envelope,
      previousCredential: existing ?? null, previousAuthority: authority ?? null,
      localPersonId: profile.identity.personId, localGrant: localGrant ?? null,
      updatedAt: new Date().toISOString() }) as WorkspaceMeshCredential
    return credential.ownerCertificates as DeviceCertificate[]
  }

  protected async installInvitationWorkspace(workspaceId: string, envelope: MeshWorkspaceEnvelope, profile: LocalProfile,
    localGrant: WorkspaceGrant | undefined): Promise<void> {
    const previous = await this.store.getWorkspaceCredential(workspaceId)
    const previousAuthority = await this.store.getWorkspaceAuthority(workspaceId)
    const credential = meshRustRuntime().state.planInvitationCredential({ workspaceId, envelope,
      previousCredential: previous ?? null, previousAuthority: previousAuthority ?? null,
      localPersonId: profile.identity.personId, localGrant: localGrant ?? null,
      updatedAt: new Date().toISOString() }) as WorkspaceMeshCredential
    await defaultStorage.withWorkspaceAuthorityMutation(workspaceId,
      context => context.write(() => this.store.putWorkspaceCredential(credential)))
    if (envelope.scopeAuthoritySnapshot) {
      meshRustRuntime().state.validateScopeAuthority(envelope.scopeAuthoritySnapshot, Date.now())
      const authority = await this.store.getWorkspaceAuthority(workspaceId)
      if (!authority) throw new Error("Workspace authority disappeared during invitation install")
      await defaultStorage.withWorkspaceAuthorityMutation(workspaceId,
        context => context.write(() => this.store.putWorkspaceAuthority({ ...authority, scopeAuthoritySnapshot: envelope.scopeAuthoritySnapshot! })))
    }
    await this.mergeInvitationCatalog(credential, envelope)
  }

  private async mergeInvitationCatalog(credential: WorkspaceMeshCredential, envelope: MeshWorkspaceEnvelope) {
    const workspaceId = credential.workspaceId
    const effects: Record<string, () => Promise<void>> = {
      deviceRevocations: () => this.mergeDeviceRevocations(credential, envelope.deviceRevocations ?? []),
      departures: () => this.mergeDepartures(credential, envelope.departures ?? []),
      revocations: () => this.mergeRevocations(credential, envelope.revocations ?? []),
      succession: async () => { await this.mergeSuccessionState(credential, envelope.successionPolicy,
        envelope.successionVotes ?? [], envelope.successionClaims ?? []) },
      refreshCredential: async () => { credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential },
      peers: () => this.mergePeerBundles(credential, envelope.peers),
    }
    for (const action of meshRustRuntime().state.planAuthorityImport("invitation", Boolean(envelope.revocations), false)) {
      const effect = effects[action]
      if (!effect) throw new Error(`Unexpected invitation authority action: ${action}`)
      await effect()
    }
  }

  async receiveInvitation(raw: unknown, workspaceIds: string[], profile: LocalProfile, grants: WorkspaceGrant[]): Promise<void> {
    const entries = await this.prepareInvitation(raw, workspaceIds, profile, grants)
    for (const entry of entries) await this.installInvitationWorkspace(entry.workspaceId, entry.envelope, profile, entry.grant)
    await this.notify()
  }

  async validateInvitation(raw: unknown, workspaceIds: string[], profile: LocalProfile, grants: WorkspaceGrant[]): Promise<Map<string, unknown>> {
    const entries = await this.prepareInvitation(raw, workspaceIds, profile, grants)
    const scopes = new Map<string, unknown>()
    for (const { workspaceId, envelope } of entries) {
      if (!envelope.scopeAuthoritySnapshot) continue
      const snapshot = structuredClone(envelope.scopeAuthoritySnapshot)
      const authority = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as {
        scopeId: string; controller: { personId: string; publicKey: string }
      }
      if (authority.scopeId !== workspaceId || authority.controller.personId !== envelope.ownerPersonId ||
          authority.controller.publicKey !== envelope.ownerPublicKey) throw new Error("Invitation scope authority differs from its verified owner")
      scopes.set(workspaceId, snapshot)
    }
    return scopes
  }

  private async prepareInvitation(raw: unknown, workspaceIds: string[], profile: LocalProfile, grants: WorkspaceGrant[]) {
    const existing = await Promise.all(workspaceIds.map(workspaceId => this.store.getWorkspaceCredential(workspaceId)))
    const plan = meshRustRuntime().state.planInvitation({ raw, workspaceIds,
      grantWorkspaceIds: grants.map(grant => grant.payload.workspaceId),
      existingOwnerPersonIds: existing.map(credential => credential?.ownerPersonId ?? null) })
    const entries: Array<{ workspaceId: string; envelope: MeshWorkspaceEnvelope; grant: WorkspaceGrant | undefined }> = []
    for (const item of plan) {
      const envelope = (raw as unknown[])[item.envelopeIndex]
      if (!isEnvelope(envelope)) throw new Error("Invalid mesh invitation")
      const grant = item.grantIndex === null ? undefined : grants[item.grantIndex]
      await this.verifyInvitationAuthority(item.workspaceId, envelope, profile, grant)
      entries.push({ workspaceId: item.workspaceId, envelope, grant })
    }
    return entries
  }

  async nextAccessEpoch(workspaceId: string): Promise<number> {
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const issued = await defaultProofStore.listGrants(workspaceId)
    return meshRustRuntime().state.nextAccessEpoch(credential ?? null, issued)
  }

  async exportWorkspace(workspaceId: string): Promise<MeshExport> {
    const peers = (await this.peerInstances(workspaceId)).filter(peer => !peer.revokedAt && peer.advertisement)
      .map(peer => peer.advertisement as WorkspaceMemberBundle)
    const credential = await this.store.getWorkspaceCredential(workspaceId)
    const authority = await this.store.getWorkspaceAuthority(workspaceId)
    return { version: 1, peers, deviceRevocations: credential ? deviceRevocations(credential) : [], departures: credential ? departures(credential) : [], revocations: credential ? revocations(credential) : [],
      ownershipTransfers: credential ? ownershipTransfers(credential) : [],
      successionPolicy: credential ? successionPolicy(credential) : undefined,
      successionVotes: credential ? successionVotes(credential) : [],
      successionClaims: credential ? successionClaims(credential) : [],
      scopeAuthoritySnapshot: authority?.scopeAuthoritySnapshot }
  }
}
