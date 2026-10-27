import { type LocalProfile} from "../domain/identity"
import * as Automerge from "@automerge/automerge/slim"
import type { DeviceCertificate } from "../domain/model"
import type { WorkspaceGrant } from "../domain/model"
import { BrowserMeshHandshake, BrowserMeshLifecycle, MeshHandshakeCodec, type MeshHandshakePayload } from "@meta-uber/mesh-runtime"
import { defaultProofStore } from "../domain/proofs"
import { startPersistentNode } from "./persistentNode"
import { meshNetworkConnection as networkConnection } from "@meta-uber/mesh-transport"
import { meshIngressBudgetProfile } from "../iroh"
import { meshRustRuntime, type RustMeshAuthenticatedSessions } from "@meta-uber/mesh-replication/runtime"
import { createPeerAdvertisement,
  verifyWorkspaceMemberBundle, type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim,
  type WorkspaceDeparture, type WorkspaceDeviceRevocation } from "./meshRecords"
import { type PeerStore, type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import type { SyncConnection, SyncNode, DuplexStream } from "./transport"
import { DurableMeshBase, MeshNodeRestart, assertRequiredMeshCapabilities, CAUSAL_WRITE_ADMISSION_CAPABILITY, departures, deviceRevocations, revocations, ownershipTransfers, successionPolicy, successionVotes, successionClaims, ownerAuthorities, uniqueCertificates, type DurableMeshOptions } from "./durableMeshBase"
import { DurableMeshAuthority } from "./durableMeshAuthority"
import { subscribeIdentityDevicePreferences } from "./identityDevicePreferenceEvents"
import { meshRecordSigning } from "./meshRecordSigning"
import { defaultStorage } from "../storage"

type InstallSessionArguments = [
  workspaceId: string,
  deviceId: string,
  instanceId: string,
  remoteIssuedAt: string,
  remoteRouteSequence: number | undefined,
  direction: "incoming" | "outgoing",
  connection: SyncConnection,
  heartbeatSupported?: boolean,
  connectionId?: string,
  ownershipReceiptSupported?: boolean,
  remotePersonId?: string,
  ownerWorkspaceSupported?: boolean,
  ownerWorkspaceOfferFrame?: "mesh-owner-workspace-offer" | "mesh-owner-workspace-offer-page-v1",
  blobTransferSupported?: boolean,
  remoteEndpoint?: string,
]

type IncomingPeer = {
  deviceId: string
  instanceId: string
  issuedAt: string
  routeSequence?: number
  personId: string
  endpoint: string
}

export abstract class DurableMeshHandshake extends DurableMeshAuthority {
  protected readonly identityPreferenceConnections = new WeakSet<SyncConnection>()
  private readonly identityPreferenceCredentials = new WeakMap<WorkspaceMeshCredential, boolean>()
  private offlineHandler: (() => void) | undefined
  private authenticatedSessions: RustMeshAuthenticatedSessions | undefined

  protected abstract publishWorkspace(workspaceId: string): Promise<void>

  private subscribeWorkspaceUpdates() {
    const stopPreferences = subscribeIdentityDevicePreferences(() => { void this.publishAll() })
    const scoped = this.options.workspace.subscribeWorkspace
    const stopWorkspace = scoped ? scoped(workspaceId => {
      if (workspaceId) void this.publishWorkspace(workspaceId)
      else void this.publishAll()
    }) : this.options.workspace.subscribe?.(() => { void this.publishAll() })
    return () => { stopPreferences(); stopWorkspace?.() }
  }

  protected rustAuthenticatedSessions(): RustMeshAuthenticatedSessions {
    return this.authenticatedSessions ??= meshRustRuntime().createMeshAuthenticatedSessions()
  }

  protected removeAuthenticatedPeer(workspaceId: string, endpoint: string): void {
    if (endpoint) this.authenticatedSessions?.remove(workspaceId, endpoint)
  }

  protected async admitSignedPeer(credential: WorkspaceMeshCredential, handshake: MeshHandshakePayload, remoteEndpointId: string) {
    const bytes = await this.options.workspaceStore.read(credential.workspaceId)
    const doc = Automerge.load<{ id: string; ownerPersonId: string }>(bytes)
    let genesisOwnerPersonId: string
    try {
      if (doc.id !== credential.workspaceId) throw new Error("Mesh document does not match workspace")
      genesisOwnerPersonId = doc.ownerPersonId
    } finally { Automerge.free(doc) }
    const genesisOwner = ownerAuthorities(credential).find(owner => owner.personId === genesisOwnerPersonId)
    if (!genesisOwner) throw new Error("Workspace genesis owner is unavailable")
    return this.rustAuthenticatedSessions().admit(handshake, {
      workspaceId: credential.workspaceId, genesisOwner, genesisEpoch: 1,
      expectedCurrentOwner: { personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
        certificates: credential.ownerCertificates },
      document: Array.from(bytes),
      ownershipTransfers: ownershipTransfers(credential), successionClaims: successionClaims(credential),
      revocations: revocations(credential),
      deviceRevocations: deviceRevocations(credential).map(value => ({ record: value.record, signer: value.authority })),
      departures: departures(credential),
    }, remoteEndpointId, Date.now())
  }

  constructor(options: DurableMeshOptions) {
    super(options)
    this.lifecycle = new BrowserMeshLifecycle({
      canStart: () => this.canStartRuntime(),
      acquireInstance: () => this.acquireInstance(),
      runOnce: signal => this.runMeshOnce(signal),
      shutdown: () => this.shutdown(),
      trace: (event, detail, level) => this.trace(event, detail, level),
      reportRestart: error => this.reportRestart(error),
      notify: () => this.notify(),
      retryChanged: () => this.options.onRetryChange?.({}),
    })
  }

  protected abstract dialLoop(signal: AbortSignal): Promise<void>

  async start(): Promise<void> { await this.lifecycle!.start() }

  async stop(releaseInstance = true): Promise<void> {
    await this.lifecycle!.stop(releaseInstance, async () => {
      await this.releaseInstance?.()
      this.releaseInstance = undefined
    })
  }

  protected async canStartRuntime(): Promise<boolean> {
    const credentials = await this.store.listWorkspaceCredentials()
    if (credentials.length > 0) {
      if (this.adoptedNode) return true
      const profile = await this.options.getProfile()
      const workspaceIds = new Set(credentials.map(credential => credential.workspaceId))
      const peers = await this.store.listPeers()
      return peers.some(peer => workspaceIds.has(peer.workspaceId) && peer.deviceId !== profile.device.deviceId)
    }
    await this.adoptedNode?.close("No mesh credentials").catch(() => {})
    this.adoptedNode = undefined
    return false
  }

  protected reportRestart(error: unknown): void {
    if (error instanceof MeshNodeRestart) {
      this.trace("node.restart", { reason: error.reason })
    } else {
      this.report("Mesh restart", error)
      console.warn("Durable mesh restarting", error)
    }
  }

  protected async shutdown() {
    this.trace("node.shutdown", { sessions: this.sessions.size, pendingIncoming: this.pendingIncomingConnections })
    this.stopWatch?.()
    this.stopWatch = undefined
    this.activeWorkspaceIds = undefined
    const offline = this.offlineHandler
    this.offlineHandler = undefined
    if (offline && typeof window !== "undefined") window.removeEventListener("offline", offline)
    const node = this.node
    this.node = undefined
    const acceptor = this.acceptor
    this.acceptor = undefined
    const adopted = this.adoptedNode
    this.adoptedNode = undefined
    try {
      this.gossip.closeAll()
      await this.dropSessions()
    } finally {
      try {
        this.authenticatedSessions?.clear()
        this.runtimeState?.stop()
        await this.gossip.waitForRefreshes()
        this.gossip.closeAll()
      } finally {
        await acceptor?.close().catch(() => {})
        await node?.close("Mesh stopped").catch(() => {})
        if (adopted !== node) await adopted?.close("Mesh stopped").catch(() => {})
      }
    }
    await this.notify()
  }

  protected async runMeshOnce(signal: AbortSignal): Promise<void> {
    this.currentRunId = ++this.runSequence
    this.trace("run.start")
    const storedCredentials = await this.store.listWorkspaceCredentials()
    const profile = await this.options.getProfile()
    const ownedWorkspaceIds = await this.options.getOwnedWorkspaceIds?.() ?? []
    if (signal.aborted || (storedCredentials.length === 0 && ownedWorkspaceIds.length === 0)) return
    let credentials = await this.activeCredentialsForProfile(storedCredentials, profile)
    if (signal.aborted || (credentials.length === 0 && ownedWorkspaceIds.length === 0)) return
    const adoptedNode = this.adoptedNode
    this.adoptedNode = undefined
    const node = adoptedNode ?? await startPersistentNode(this.options.transport, this.store, this.instanceId)
    if (signal.aborted) return void node.close("Mesh cancelled")
    this.node = node
    this.trace("node.started", { source: adoptedNode ? "adopted" : "instance", endpoint: node.endpointId.slice(0, 8) })
    if (ownedWorkspaceIds.length > 0) credentials = await this.prepareOwnedWorkspaces(ownedWorkspaceIds, node, profile)
    await this.prepareCredentials(credentials, profile, node.endpointId)
    this.acceptor = await node.accept()
    const offline = () => { void this.dropSessions() }
    this.offlineHandler = offline
    if (typeof window !== "undefined") window.addEventListener("offline", offline)
    this.stopWatch = this.subscribeWorkspaceUpdates()
    await this.superviseNode(signal)
  }

  private async superviseNode(signal: AbortSignal): Promise<void> {
    const run = new AbortController()
    const cancel = () => run.abort()
    signal.addEventListener("abort", cancel, { once: true })
    if (signal.aborted) cancel()
    try {
      const ended = await Promise.race([
        this.acceptLoop(run.signal).then(() => "accept"),
        this.dialLoop(run.signal).then(() => "dial"),
      ])
      if (!signal.aborted) throw new MeshNodeRestart(`${ended} loop closed`)
    } finally {
      cancel()
      signal.removeEventListener("abort", cancel)
    }
  }

  protected async prepareOwnedWorkspaces(ids: string[], node: SyncNode, profile: LocalProfile): Promise<WorkspaceMeshCredential[]> {
    await this.ensureOwnerWorkspaces(ids, node.endpointId, profile)
    return this.activeCredentialsForProfile(await this.store.listWorkspaceCredentials(), profile)
  }

  protected async prepareCredentials(credentials: WorkspaceMeshCredential[], profile: LocalProfile, endpoint: string): Promise<void> {
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    for (let credential of credentials) {
      credential = await this.refreshOwnerCertificates(credential, profile, certificates)
      await this.refreshOwnBundle(credential, profile, endpoint, certificates)
      await this.pruneInvalidStoredPeers(credential, profile.device.deviceId)
    }
  }

  protected async dropSessions() {
    const sessions = [...this.sessions.values()]
    await Promise.allSettled(sessions.map(entry => entry.evict("mesh stopped")))
    await this.notify()
  }

  protected async acceptLoop(signal: AbortSignal) {
    this.trace("accept.loop.started")
    while (!signal.aborted && this.acceptor) {
      try {
        const raw = await this.acceptor.accept()
        if (!raw) {
          this.trace("accept.loop.closed")
          return
        }
        const connectionId = this.connectionId("incoming")
        this.pendingIncomingConnections += 1
        this.trace("accept.connection", { connectionId })
        void this.acceptConnection(networkConnection(raw, meshIngressBudgetProfile()), signal, undefined, connectionId).finally(() => {
          this.pendingIncomingConnections = Math.max(0, this.pendingIncomingConnections - 1)
        })
      } catch (error) {
        if (!signal.aborted) {
          this.trace("accept.failed", { reason: error instanceof Error ? error.message : String(error) }, "warn")
          throw new MeshNodeRestart(`accept failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }
  protected readonly handshakeCodec = new MeshHandshakeCodec()
  private readonly browserHandshake = new BrowserMeshHandshake<WorkspaceMeshCredential, IncomingPeer>({
    credentials: () => this.store.listWorkspaceCredentials(),
    secret: credential => credential.transportSecret,
    workspaceId: credential => credential.workspaceId,
    mergeAuthority: (credential, request) => this.mergeIncomingAuthority(credential, request),
    verifyPeer: (credential, bundle) => this.verifyIncomingPeer(credential, bundle),
    admit: (credential, request, remoteEndpointId) => this.admitSignedPeer(credential, request, remoteEndpointId),
    revocations: credential => revocations(credential),
    ownBundle: credential => this.ownBundle(credential),
    response: (credential, remotePersonId) => this.incomingResponse(credential, remotePersonId),
    putVerifiedBundle: (credential, bundle) => this.putVerifiedBundle(credential, bundle),
    install: ({ credential, remote, connection, features, connectionId }) => {
      if (this.identityPreferenceCredentials.get(credential)) this.identityPreferenceConnections.add(connection as SyncConnection)
      return this.installSession(
      credential.workspaceId, remote.deviceId, remote.instanceId, remote.issuedAt, remote.routeSequence,
      "incoming", connection as SyncConnection, features.heartbeatSupported,
      connectionId, features.ownershipReceiptSupported, remote.personId, features.ownerWorkspaceSupported, features.ownerWorkspaceOfferFrame,
      features.blobTransferSupported, remote.endpoint)
    },
    afterInstalled: ({ credential, remote, request, connection, features }) => this.afterIncomingInstall(
      credential, remote, request.ownerWorkspaceIds, connection as SyncConnection, features.ownerWorkspaceOfferFrame),
    trace: (event, detail, level) => this.trace(event, detail, level),
    failed: (stage, error) => this.reportProtocolFailure(stage, error),
  }, this.handshakeCodec)

  protected abstract installSession(...args: InstallSessionArguments): Promise<boolean>

  async acceptOnInvitationNode(connection: SyncConnection, stream: DuplexStream, frame: Uint8Array) {
    await this.acceptConnection(connection, undefined, { stream, frame }, this.connectionId("incoming"))
    const entry = [...this.sessions.values()].find(item => item.connection === connection)
    if (!entry) return
    const unsubscribe = this.options.workspace.subscribe?.(() => {
      void this.publishAll()
    })
    void entry.session.done.then(() => unsubscribe?.(), () => unsubscribe?.())
  }

  protected async acceptConnection(connection: SyncConnection, signal?: AbortSignal,
    initial?: { stream: DuplexStream; frame: Uint8Array }, connectionId = this.connectionId("incoming")) {
    await this.browserHandshake.accept(connection, initial, connectionId, signal)
  }

  protected async mergeIncomingAuthority(credential: WorkspaceMeshCredential, request: {
    departures?: WorkspaceDeparture[]; deviceRevocations?: WorkspaceDeviceRevocation[]; capabilities?: string[];
    ownershipTransfers?: WorkspaceOwnershipTransfer[];
    successionPolicy?: WorkspaceSuccessionPolicy; successionVotes?: WorkspaceSuccessionVote[]; successionClaims?: WorkspaceSuccessionClaim[]
  }): Promise<WorkspaceMeshCredential> {
    const workspaceId = credential.workspaceId
    const effects: Record<string, () => Promise<void>> = {
      validateCapabilities: async () => { assertRequiredMeshCapabilities(request.capabilities) },
      deviceRevocations: () => this.mergeDeviceRevocations(credential, request.deviceRevocations ?? []),
      departures: () => this.mergeDepartures(credential, request.departures ?? []),
      ownershipTransfers: async () => { credential = await this.mergeOwnershipTransfers(credential, request.ownershipTransfers ?? []) },
      succession: async () => { await this.mergeSuccessionState(credential, request.successionPolicy,
        request.successionVotes ?? [], request.successionClaims ?? []) },
      refreshCredential: async () => { credential = await this.store.getWorkspaceCredential(workspaceId) ?? credential },
    }
    for (const action of meshRustRuntime().state.planMeshHandshakeAuthorityImport()) {
      const effect = effects[action]
      if (!effect) throw new Error(`Unexpected handshake authority action: ${action}`)
      await effect()
    }
    await this.reclassifyWorkspaceAuthority(workspaceId)
    const current = await this.store.getWorkspaceCredential(workspaceId) ?? credential
    this.identityPreferenceCredentials.set(current, request.capabilities?.includes("identity-device-preferences-v1") ?? false)
    return current
  }

  protected async verifyIncomingPeer(credential: WorkspaceMeshCredential, bundle: WorkspaceMemberBundle): Promise<IncomingPeer> {
    const remote = await verifyWorkspaceMemberBundle(bundle, { workspaceId: credential.workspaceId,
      ownerPersonId: credential.ownerPersonId, ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as DeviceCertificate[], ownerHistory: ownerAuthorities(credential).slice(1) })
    const payload = remote.advertisement.payload
    return { deviceId: payload.deviceId, instanceId: payload.instanceId ?? "legacy", issuedAt: payload.issuedAt,
      routeSequence: payload.routeSequence, personId: payload.personId, endpoint: payload.endpoint }
  }

  protected async incomingResponse(credential: WorkspaceMeshCredential, remotePersonId: string): Promise<MeshHandshakePayload> {
    const profile = await this.options.getProfile()
    const ownerWorkspaceIds = meshRustRuntime().state.shouldAdvertiseOwnerWorkspaceIds(
      credential.ownerPersonId, profile.identity.personId, remotePersonId)
      ? await this.ownerWorkspaceIds(profile) : undefined
    return this.validateHandshake({ workspaceId: credential.workspaceId, peer: await this.ownBundle(credential),
      ownershipTransfers: ownershipTransfers(credential), successionPolicy: successionPolicy(credential),
      successionVotes: successionVotes(credential), successionClaims: successionClaims(credential),
      revocations: revocations(credential), deviceRevocations: deviceRevocations(credential), departures: departures(credential),
      ownerWorkspaceIds, capabilities: [...this.handshakeCodec.capabilities(), CAUSAL_WRITE_ADMISSION_CAPABILITY, "identity-device-preferences-v1"] }, credential.workspaceId)
  }

  protected async afterIncomingInstall(credential: WorkspaceMeshCredential, remote: IncomingPeer,
    ownerWorkspaceIds: string[] | undefined, connection: SyncConnection,
    ownerWorkspaceOfferFrame: "mesh-owner-workspace-offer" | "mesh-owner-workspace-offer-page-v1" | undefined): Promise<void> {
    await this.refreshWorkspaceGossip(credential.workspaceId)
    await this.offerMissingOwnerWorkspaces(connection, credential.transportSecret, ownerWorkspaceIds, remote.personId,
      ownerWorkspaceOfferFrame)
  }

  protected validateHandshake(raw: unknown, workspaceId: string): MeshHandshakePayload {
    return this.handshakeCodec.validate(raw, workspaceId)
  }

  protected async ownBundle(credential: WorkspaceMeshCredential) {
    const profile = await this.options.getProfile()
    const peers = await this.peerInstances(credential.workspaceId)
    let own = this.selectLocalHandshakePeer(peers, profile.device.deviceId)
    if (!own) {
      const fallback = await this.store.getPeer(credential.workspaceId, profile.device.deviceId)
      own = fallback ? this.selectLocalHandshakePeer([fallback], profile.device.deviceId) : undefined
    }
    if (!own?.advertisement) throw new Error("Missing local peer advertisement")
    return own.advertisement as WorkspaceMemberBundle
  }

  protected async refreshOwnBundle(credential: WorkspaceMeshCredential, profile: LocalProfile,
    endpoint: string, certificates: DeviceCertificate[]) {
    let current = await this.localPeerInstance(credential.workspaceId, profile.device.deviceId)
    // Device enrollment keeps the browser's device key while replacing its person identity.
    // Never let the old identity win PeerStore's timestamp merge for the same device key.
    if (current && current.personId !== profile.identity.personId) {
      await this.store.removePeer(credential.workspaceId, profile.device.deviceId)
      current = null
    }
    let bundle = current?.advertisement as WorkspaceMemberBundle | undefined
    if (bundle) {
      try {
        await verifyWorkspaceMemberBundle(bundle, {
          workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
          ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
          ownerHistory: ownerAuthorities(credential).slice(1),
          allowStaleRoute: true,
        })
      } catch {
        await this.store.removePeer(credential.workspaceId, profile.device.deviceId)
        current = null
        bundle = undefined
      }
    }
    const localGrant = credential.localGrant as WorkspaceGrant | undefined
    const agent = (typeof navigator !== "undefined" ? navigator.userAgent : "").trim().slice(0, 256) || null
    const signing = await meshRecordSigning(profile, credential, { kind: "advertisement" }, this.store)
    const reusable = meshRustRuntime().state.canReuseMemberBundle({ bundle: bundle ?? null,
      currentPeer: current ?? null, credential, localPersonId: profile.identity.personId,
      localPublicKey: profile.identity.publicKey, expectedDeviceName: profile.device.displayName.slice(0, 256),
      expectedUserAgent: agent, endpoint, instanceId: this.instanceId, certificates: signing.certificates,
      localGrant: localGrant ?? null, nowMs: Date.now(), renewMs: DurableMeshBase.ROUTE_RENEW_MS })
    if (reusable) return bundle
    const sequenceStore = this.store as PeerStore & {
      nextInstanceAdvertisementSequence?: (instanceId: string) => Promise<number>
    }
    const routeSequence = sequenceStore.nextInstanceAdvertisementSequence
      ? await sequenceStore.nextInstanceAdvertisementSequence(this.instanceId)
      : Date.now()
    const now = Date.now()
    const next = await createPeerAdvertisement(profile, credential.workspaceId, endpoint, {
      signing,
      certificates,
      grant: localGrant,
      ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
      ...(this.instanceId ? { instanceId: this.instanceId } : {}),
      routeSequence,
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DurableMeshBase.ROUTE_LEASE_MS).toISOString(),
    })
    await this.putVerifiedBundle(credential, next)
    return next
  }

  private async localPeerInstance(workspaceId: string, deviceId: string): Promise<WorkspacePeerRecord | null> {
    const peers = await this.peerInstances(workspaceId)
    return this.selectLocalHandshakePeer(peers, deviceId) ?? this.store.getPeer(workspaceId, deviceId)
  }

  private selectLocalHandshakePeer(peers: WorkspacePeerRecord[], deviceId: string): WorkspacePeerRecord | undefined {
    const index = meshRustRuntime().state.selectMeshHandshakeBundle(peers, deviceId, this.instanceId)
    return index === null ? undefined : peers[index]
  }

  protected async pruneInvalidStoredPeers(credential: WorkspaceMeshCredential, localDeviceId: string) {
    for (const peer of await this.store.listPeers(credential.workspaceId)) {
      if (peer.deviceId === localDeviceId || peer.revokedAt || !peer.advertisement) continue
      try {
        await verifyWorkspaceMemberBundle(peer.advertisement, {
          workspaceId: credential.workspaceId, ownerPersonId: credential.ownerPersonId,
          ownerPublicKey: credential.ownerPublicKey, ownerCertificates: credential.ownerCertificates as DeviceCertificate[],
          ownerHistory: ownerAuthorities(credential).slice(1),
          allowStaleRoute: true,
        })
      } catch {
        await defaultStorage.withWorkspaceAuthorityMutation(credential.workspaceId,
          context => context.write(() => this.store.removePeer(credential.workspaceId, peer.deviceId)))
        this.clearRouteReconnects(`${credential.workspaceId}:${peer.deviceId}:`)
      }
    }
  }

}
