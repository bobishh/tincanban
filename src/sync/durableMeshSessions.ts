import { type LocalProfile} from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { isMeshNetworkFailure, meshNetworkConnection as networkConnection, meshNetworkIO as networkIO } from "@meta-uber/mesh-transport"
import { meshIngressBudgetProfile } from "../iroh"
import { BrowserMeshDialScheduler, BrowserMeshOutgoingHandshake, BrowserMeshSessions } from "@meta-uber/mesh-runtime"
import { adaptVerifiedWorkspaceAdvertisement, connectToDevice, type DeviceRoute } from "@meta-uber/mesh-replication/protocol"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { defaultProofStore } from "../domain/proofs"
import { respondToBlobRequest, type BlobDescriptor } from "@meta-uber/mesh-blob"
import { verifyWorkspaceMemberBundle, type WorkspaceMemberBundle } from "./meshRecords"
import { type WorkspaceMeshCredential, type WorkspacePeerRecord } from "./peerStore"
import { workspaceAuthorityFingerprint } from "./authorityFingerprint"
import type { SyncConnection, SyncNode } from "./transport"
import { type LiveWorkspaceSync, type PeerHistoryBaselineDescriptor} from "./workspaceSet"
import { DurableMeshBase, MeshDialCancelled, MeshNodeRestart, CAUSAL_WRITE_ADMISSION_CAPABILITY, uniqueCertificates, ownershipTransfers, successionPolicy, successionVotes, successionClaims, ownerAuthorities, revocations, isGrantRevoked,
  departures, hasLeftWorkspace, deviceRevocations, isDeviceRevoked,
  type MeshPeerView, type MeshSuccessionView, type SessionEntry } from "./durableMeshBase"
import { DurableMeshHandshake } from "./durableMeshHandshake"
import { participantWorkspaceSession } from "./participantWorkspaceStore"
import type { ArchiveObjectReadBinding } from "@meta-uber/mesh-replication/history-archive"
import { fetchBlobFromCurrentSessions } from "./durableMeshBlobFetch"
import { readDurableMeshTransferAuthority } from "./durableMeshTransferAuthority"
import { fetchDurableMeshHistoryObject, fetchDurableMeshHistoryBaseline, fetchDurableMeshHistoryDocument } from "./durableMeshHistoryFetch"
import { MeshDialRouteSelector, routeLeaseFields } from "./durableMeshDialRoutes"
export { isNativeKeeperRoute } from "./nativeKeeperRoute"

export class DurableMeshSessions extends DurableMeshHandshake {
  private readonly rustyAccessMaintenance = new WeakMap<SyncConnection, ReturnType<typeof participantWorkspaceSession>["maintenance"]>()
  private readonly workspacePublishTasks = new Map<string, Promise<void>>()
  private readonly dirtyWorkspacePublishes = new Set<string>()
  private authorityReadFailure = 0
  private readonly dialRoutes = new MeshDialRouteSelector({
    connected: (workspaceId, deviceId) => this.hasDeviceSession(workspaceId, deviceId),
    trace: (event, detail) => this.trace(event, detail),
  })

  private clearWorkspaceDiagnostic(workspaceId: string, deviceId: string) {
    const stage = `Workspace ${workspaceId.slice(0, 8)} from ${deviceId.slice(0, 8)}`
    if (!this.lastDiagnostic.startsWith(`${stage}:`)) return
    this.lastDiagnostic = ""
    this.options.onDiagnostic?.("")
  }
  private readonly dialScheduler = new BrowserMeshDialScheduler<WorkspacePeerRecord>({
    peers: async () => this.dialRoutes.select(await this.peerInstances()),
    hasSession: (workspaceId, deviceId, instanceId) => this.hasPeerSession(workspaceId, deviceId, instanceId),
    peerKey: (workspaceId, deviceId, instanceId) => this.peerKey(workspaceId, deviceId, instanceId),
    routeFailures: key => this.routeFailures(key),
    retryAt: (key, fallback) => this.runtimeState?.reconnectState(key)?.retryAtMs ?? fallback,
    routeAttemptActive: key => this.runtime().routeAttemptActive(key),
    dial: (routes, signal) => this.dialDevice(routes, signal),
    onRetries: retries => this.options.onRetryChange?.(retries),
  })

  private readonly outgoingHandshake = new BrowserMeshOutgoingHandshake<WorkspaceMeshCredential, {
    deviceId: string; instanceId: string; issuedAt: string; routeSequence?: number; personId: string; endpoint: string
  }, WorkspacePeerRecord>({
    secret: credential => credential.transportSecret,
    workspaceId: credential => credential.workspaceId,
    request: (credential, peer) => this.outgoingRequest(credential, peer),
    mergeAuthority: (credential, response) => this.mergeIncomingAuthority(credential, response),
    verifyPeer: (credential, bundle) => this.verifyOutgoingHandshakePeer(credential, bundle),
    admit: (credential, response, remoteEndpointId) => this.admitSignedPeer(credential, response, remoteEndpointId),
    putVerifiedBundle: (credential, bundle) => this.putVerifiedBundle(credential, bundle),
    trace: (event, detail, level) => this.trace(event, detail, level),
  }, this.handshakeCodec)

  protected hasPeerSession(workspaceId: string, deviceId: string, instanceId = "legacy") {
    return this.runtimeState?.sessions().some(session =>
      session.key.workspaceId === workspaceId && session.key.deviceId === deviceId && session.key.instanceId === instanceId,
    ) ?? false
  }

  protected hasDeviceSession(workspaceId: string, deviceId: string) {
    return this.runtimeState?.connectedDevices(workspaceId).includes(deviceId) ?? false
  }

  protected async dialLoop(signal: AbortSignal) {
    let nextRouteRefreshAt = Date.now() + DurableMeshBase.ROUTE_RENEW_MS
    while (!signal.aborted) {
      if (!this.node) throw new MeshNodeRestart("runtime node unavailable")
      if (await this.pauseDialingWhenOffline(signal)) continue
      const profile = await this.options.getProfile()
      nextRouteRefreshAt = await this.refreshRoutesWhenDue(profile, nextRouteRefreshAt)
      await this.scheduleDials(profile.device.deviceId, signal)
      await this.waitForDialTick(signal)
    }
  }

  protected async pauseDialingWhenOffline(signal: AbortSignal): Promise<boolean> {
    if (this.options.networkOnline?.() !== false) return false
    this.options.onRetryChange?.({})
    await this.waitForDialTick(signal)
    return true
  }

  protected async refreshRoutesWhenDue(profile: LocalProfile, nextAt: number): Promise<number> {
    if (Date.now() < nextAt) return nextAt
    const certificates = uniqueCertificates(profile, await defaultProofStore.listCertificates())
    for (const credential of await this.activeCredentialsForProfile(await this.store.listWorkspaceCredentials(), profile)) {
      await this.refreshOwnBundle(credential, profile, this.node!.endpointId, certificates)
    }
    await this.publishAll()
    return Date.now() + DurableMeshBase.ROUTE_RENEW_MS
  }

  protected async scheduleDials(localDeviceId: string, signal: AbortSignal): Promise<void> {
    await this.dialScheduler.schedule(localDeviceId, this.instanceId, signal)
  }

  protected waitForDialTick(signal: AbortSignal) {
    return this.lifecycle!.wait(1_000, signal)
  }

  protected async dialDevice(peers: WorkspacePeerRecord[], signal: AbortSignal) {
    const peer = peers[0]!
    const key = this.peerKey(peer.workspaceId, peer.deviceId, peer.instanceId)
    if (this.runtime().routeAttemptActive(key)) return
    const attempt = this.runtime().beginRouteAttempt(key, Date.now())
    try {
      this.throwIfDialCancelled(signal, signal)
      if (!this.node || this.hasPeerSession(peer.workspaceId, peer.deviceId, peer.instanceId)) return
      const routeEntries = await Promise.all(peers.map(async candidate => ({
        peer: candidate,
        route: await adaptVerifiedWorkspaceAdvertisement(
          (candidate.advertisement as WorkspaceMemberBundle).advertisement,
        ),
      })))
      const connected = await connectToDevice({
        targetDeviceId: peer.deviceId,
        routes: routeEntries.map(value => value.route),
        fallbackDelayMs: 250,
        routeHealth: route => -this.routeFailures(this.peerKey(route.scopeId, route.deviceId, route.instanceId)),
        trace: (event, fields) => this.trace(event, { workspaceId: peer.workspaceId, ...fields,
          ...routeLeaseFields(peers.find(value => value.instanceId === fields.instanceId) ?? peer) }),
        signal,
        connect: async (route, routeSignal) => {
          const entry = routeEntries.find(value => value.route.instanceId === route.instanceId)!
          return this.connectPeer(entry.peer, route, signal, routeSignal)
        },
      })
      const value = connected.value
      const installed = await this.installSession(peer.workspaceId, peer.deviceId, value.instanceId,
        value.issuedAt, value.routeSequence, "outgoing", value.connection,
        value.heartbeatSupported, value.connectionId, value.ownershipReceiptSupported,
        value.personId, value.ownerWorkspaceSupported, value.ownerWorkspaceOfferFrame, value.blobTransferSupported, value.endpoint)
      if (installed) await this.refreshWorkspaceGossip(peer.workspaceId)
      if (installed && value.ownerWorkspaceOfferFrame) {
        const credential = await this.store.getWorkspaceCredential(peer.workspaceId)
        if (credential) await this.offerMissingOwnerWorkspaces(value.connection, credential.transportSecret,
          value.ownerWorkspaceIds, value.personId, value.ownerWorkspaceOfferFrame)
      }
    } catch (error) {
      if (signal.aborted || error instanceof MeshDialCancelled) {
        this.trace("dial.device.cancelled", { peerId: peer.deviceId, workspaceId: peer.workspaceId })
        return
      }
      if (this.hasPeerSession(peer.workspaceId, peer.deviceId, peer.instanceId)) {
        this.trace("dial.device.superseded", {
          peerId: peer.deviceId,
          workspaceId: peer.workspaceId,
          routes: peers.length,
          reason: error instanceof Error ? error.message : String(error),
        })
        return
      }
      this.trace("dial.device.failed", {
        peerId: peer.deviceId,
        workspaceId: peer.workspaceId,
        routes: peers.length,
        reason: error instanceof Error ? error.message : String(error),
      }, "warn", error)
      this.reportProtocolFailure(`Dial ${peer.deviceId.slice(0, 6)}`, error)
      await this.notify()
    } finally {
      this.runtime().finishRouteAttempt(key, attempt.token)
    }
  }

  protected async connectPeer(peer: WorkspacePeerRecord, route: DeviceRoute, signal: AbortSignal, routeSignal: AbortSignal) {
    const key = this.peerKey(peer.workspaceId, peer.deviceId, peer.instanceId)
    const connectionId = this.connectionId("outgoing")
    const node = this.node
    let connection: SyncConnection | undefined
    try {
      if (!node) throw new MeshDialCancelled()
      this.throwIfDialCancelled(signal, routeSignal, node)
      let credential = await this.requireDialCredential(peer)
      this.throwIfDialCancelled(signal, routeSignal, node)
      connection = await this.openPeerConnection(peer, route, key, connectionId, node)
      const handshake = await this.exchangeOutgoingHandshake(connection, peer, credential, connectionId)
      if (handshake.response.capabilities?.includes("identity-device-preferences-v1")) this.identityPreferenceConnections.add(connection)
      credential = handshake.credential
      if (Array.isArray(handshake.response.revocations)) await this.mergeRevocations(credential, handshake.response.revocations)
      this.throwIfDialCancelled(signal, routeSignal, node)
      const result = { connection, connectionId, instanceId: handshake.remote.instanceId, issuedAt: handshake.remote.issuedAt,
        routeSequence: handshake.remote.routeSequence, personId: handshake.remote.personId, endpoint: handshake.remote.endpoint,
        ownerWorkspaceIds: handshake.response.ownerWorkspaceIds, ...handshake.features }
      connection = undefined
      return result
    } catch (error) {
      await this.handleDialFailure(error, connection, peer, key, connectionId, signal, routeSignal, node)
      throw error
    }
  }

  protected throwIfDialCancelled(signal: AbortSignal, routeSignal: AbortSignal, node = this.node): void {
    if (!node || this.node !== node || signal.aborted || routeSignal.aborted) throw new MeshDialCancelled()
  }

  protected async requireDialCredential(peer: WorkspacePeerRecord): Promise<WorkspaceMeshCredential> {
    // Routes may retain an older secret after recovery. Workspace credentials
    // select the key; the signed handshake still admits current membership.
    const credential = await this.store.getWorkspaceCredential(peer.workspaceId)
    if (!credential) throw new Error("Mesh credential unavailable")
    return credential
  }

  protected async openPeerConnection(peer: WorkspacePeerRecord, route: DeviceRoute, key: string, connectionId: string, node: SyncNode): Promise<SyncConnection> {
    const mode = this.reconnectPolicy.mode(node, key)
    this.trace("dial.started", { connectionId, peerId: peer.deviceId, workspaceId: peer.workspaceId,
      endpoint: peer.endpoint.slice(0, 8), mode })
    const connection = networkConnection(await networkIO(this.reconnectPolicy.dial<Awaited<ReturnType<SyncNode["dial"]>>>(node, key, route.endpoint)),
      meshIngressBudgetProfile())
    this.trace("dial.connected", { connectionId, peerId: peer.deviceId, mode })
    return connection
  }

  protected async exchangeOutgoingHandshake(connection: SyncConnection, peer: WorkspacePeerRecord,
    credential: WorkspaceMeshCredential, connectionId: string) {
    return this.outgoingHandshake.exchange(connection, credential, connectionId, peer.deviceId, peer)
  }

  protected async outgoingRequest(credential: WorkspaceMeshCredential, peer: WorkspacePeerRecord) {
    const profile = await this.options.getProfile()
    const ownerWorkspaceIds = credential.ownerPersonId === profile.identity.personId && peer.personId === profile.identity.personId
      ? await this.ownerWorkspaceIds(profile) : undefined
    return this.validateHandshake({ workspaceId: peer.workspaceId, peer: await this.ownBundle(credential),
      ownershipTransfers: ownershipTransfers(credential), successionPolicy: successionPolicy(credential),
      successionVotes: successionVotes(credential), successionClaims: successionClaims(credential),
      revocations: revocations(credential), deviceRevocations: deviceRevocations(credential), departures: departures(credential),
      ownerWorkspaceIds, capabilities: [...this.handshakeCodec.capabilities(), CAUSAL_WRITE_ADMISSION_CAPABILITY, "identity-device-preferences-v1"] }, peer.workspaceId)
  }

  protected async verifyOutgoingHandshakePeer(credential: WorkspaceMeshCredential, bundle: WorkspaceMemberBundle) {
    const verified = await verifyWorkspaceMemberBundle(bundle, { workspaceId: credential.workspaceId,
      ownerPersonId: credential.ownerPersonId, ownerPublicKey: credential.ownerPublicKey,
      ownerCertificates: credential.ownerCertificates as DeviceCertificate[], ownerHistory: ownerAuthorities(credential).slice(1) })
    const payload = verified.advertisement.payload
    return { deviceId: payload.deviceId, instanceId: payload.instanceId ?? "legacy", issuedAt: payload.issuedAt,
      routeSequence: payload.routeSequence, personId: payload.personId, endpoint: payload.endpoint }
  }

  protected async handleDialFailure(error: unknown, connection: SyncConnection | undefined, peer: WorkspacePeerRecord, key: string,
    connectionId: string, signal: AbortSignal, routeSignal: AbortSignal, node: SyncNode | undefined): Promise<void> {
    if (error instanceof MeshDialCancelled || signal.aborted || routeSignal.aborted || this.node !== node) {
      await connection?.close().catch(() => {})
      this.trace("dial.cancelled", { connectionId, peerId: peer.deviceId })
      throw new MeshDialCancelled()
    }
    this.recordRouteFailure(key, error)
    this.trace("dial.failed", { connectionId, peerId: peer.deviceId,
      reason: error instanceof Error ? error.message : String(error) }, "warn", error)
    if (!this.hasPeerSession(peer.workspaceId, peer.deviceId, peer.instanceId)) this.reportProtocolFailure(`Dial ${peer.deviceId.slice(0, 6)}`, error)
    else this.trace("dial.failure.superseded", { connectionId, peerId: peer.deviceId })
    await connection?.close().catch(() => {})
    if (this.node === node && /runtime node is closed|node is closed/i.test(error instanceof Error ? error.message : String(error))) {
      this.node = undefined
      await node?.close("Mesh runtime closed").catch(() => {})
    }
  }
  private readonly browserSessions = new BrowserMeshSessions<SyncConnection, LiveWorkspaceSync, LocalProfile>({
    profile: this.options.getProfile,
    deviceId: profile => profile.device.deviceId,
    instanceId: () => this.instanceId,
    credential: workspaceId => this.store.getWorkspaceCredential(workspaceId),
    create: input => {
      const credential = input.credential as WorkspaceMeshCredential
      const stage = `Workspace ${input.workspaceId.slice(0, 8)} from ${input.deviceId.slice(0, 8)}`
      const created = participantWorkspaceSession(this.options.workspaceStore, { workspaceId: input.workspaceId, deviceId: input.deviceId,
        remotePersonId: input.remotePersonId, transportSecret: credential.transportSecret, profile: input.profile, store: this.store,
        profileProvider: () => this.options.getProfile(), assertSession: () => {
          if (this.stopped || this.sessions.get(this.peerKey(input.workspaceId, input.deviceId, input.instanceId))?.connection !== input.connection) {
            throw new Error("Direct peer session is no longer current")
          }
        } }, this.identityPreferenceConnections.has(input.connection), input.connection, error => {
          if (error) {
            this.trace("document.rejected", { connectionId: input.connectionId, workspaceId: input.workspaceId,
              peerId: input.deviceId, instanceId: input.instanceId, reason: error.message }, "warn", error)
            this.report(stage, error)
          } else if (this.lastDiagnostic.startsWith(`${stage}:`)) {
            this.lastDiagnostic = ""
            this.options.onDiagnostic?.("")
          }
        }, {
          ownerWorkspaceOfferFrame: input.ownerWorkspaceOfferFrame,
          onOwnerWorkspaceOffer: input.ownerWorkspaceOfferFrame && input.remotePersonId === input.profile.identity.personId
            ? bytes => this.receiveOwnerWorkspaceOffer(bytes, input.remotePersonId,
              input.connection, credential.transportSecret) : undefined,
          onGossipPacket: input.remoteEndpoint
            ? packet => this.receiveWorkspaceGossipPacket(input.workspaceId, input.remoteEndpoint, packet) : undefined,
          onBlobRequest: input.blobTransferSupported
            ? (stream, frame) => this.respondToBlobRequest(input.workspaceId, input.deviceId, credential.transportSecret, stream, frame)
            : undefined,
        })
      this.rustyAccessMaintenance.set(input.connection, created.maintenance)
      return created
    },
    runtime: () => this.runtime(),
    key: (workspaceId, deviceId, instanceId) => this.peerKey(workspaceId, deviceId, instanceId),
    stopped: () => this.stopped,
    trace: (event, detail, level) => this.trace(event, detail, level),
    diagnosticCleared: () => {
      if (!this.lastDiagnostic.startsWith("Workspace ")) {
        this.lastDiagnostic = ""
        this.options.onDiagnostic?.("")
      }
    },
    currentRemoved: async entry => {
      this.clearWorkspaceDiagnostic(entry.workspaceId, entry.deviceId)
      this.removeAuthenticatedPeer(entry.workspaceId, entry.endpoint)
      await this.refreshWorkspaceGossip(entry.workspaceId)
      if (!this.stopped) queueMicrotask(() => { void this.publishAll() })
      await this.notify()
    },
    notify: () => this.notify(),
    publishRecovered: (key, entry) => this.stopped || this.sessions.get(key) !== entry
      ? Promise.resolve() : this.publishCurrentSession(key, entry as SessionEntry),
    stableSession: key => this.clearRouteReconnect(key),
    protocolFailure: (stage, error) => this.reportProtocolFailure(stage, error),
    networkFailure: (key, error) => { this.recordRouteFailure(key, error) },
  }, this.sessions)

  protected async installSession(workspaceId: string, deviceId: string, instanceId: string, remoteIssuedAt: string,
    remoteRouteSequence: number | undefined, direction: "incoming" | "outgoing", connection: SyncConnection, heartbeatSupported = false,
    connectionId = this.connectionId(direction), ownershipReceiptSupported = false,
    remotePersonId = "", ownerWorkspaceSupported = false,
    ownerWorkspaceOfferFrame: "mesh-owner-workspace-offer" | "mesh-owner-workspace-offer-page-v1" | undefined = undefined,
    blobTransferSupported = false, remoteEndpoint = "") {
    try {
      return await this.browserSessions.install({ workspaceId, deviceId, instanceId, remoteIssuedAt, remoteRouteSequence,
        direction, connection, heartbeatSupported, connectionId, ownershipReceiptSupported,
        remotePersonId, ownerWorkspaceSupported, ownerWorkspaceOfferFrame, blobTransferSupported, remoteEndpoint })
    } finally {
      const current = this.sessions.get(this.peerKey(workspaceId, deviceId, instanceId))
      if (current?.connection === connection) this.rustyAccessMaintenance.get(connection)?.start()
    }
  }

  private async respondToBlobRequest(workspaceId: string, deviceId: string, secret: string,
    stream: Parameters<typeof respondToBlobRequest>[0], frame: Uint8Array): Promise<void> {
    const blob = this.options.workspaceStore.blob
    if (!blob) throw new Error("Blob storage is unavailable")
    const peer = await this.store.getPeer(workspaceId, deviceId)
    const bundle = peer?.advertisement as WorkspaceMemberBundle | undefined
    if (!peer || !bundle?.publicKey || !Array.isArray(bundle.certificates)) throw new Error("Blob requester is unavailable")
    await respondToBlobRequest(stream, frame, {
      secret,
      scopeId: workspaceId,
      identity: {
        personId: peer.personId,
        publicKey: bundle.publicKey,
        displayName: bundle.advertisement?.payload?.deviceName ?? "Peer",
      },
      certificates: bundle.certificates,
      descriptor: blobId => blob.resolve(workspaceId, blobId),
      bytes: descriptor => blob.read(descriptor),
    })
  }

  async fetchBlob(workspaceId: string, descriptor: BlobDescriptor): Promise<Uint8Array | undefined> {
    descriptor = structuredClone(descriptor)
    const blob = this.options.workspaceStore.blob
    if (!blob) return undefined
    return fetchBlobFromCurrentSessions({
      workspaceId, descriptor, blob,
      readAuthority: () => readDurableMeshTransferAuthority({ workspaceId, descriptor, getProfile: () => this.options.getProfile(),
        store: this.store, blob: this.options.workspaceStore.blob, revokedWorkspaceIds: (credentials, profile) => this.revokedWorkspaceIds(credentials, profile) }),
      sessions: () => [...this.sessions.values()].filter(entry => entry.workspaceId === workspaceId && entry.blobTransferSupported),
      isCurrent: (entry, runId) => this.currentRunId === runId && this.sessions.get(this.peerKey(workspaceId, entry.deviceId, entry.instanceId)) === entry,
      currentRunId: () => this.currentRunId, isRunning: () => !this.stopped,
    })
  }

  async fetchHistoryObject(workspaceId: string, baselineId: string, objectId: string,
    binding: ArchiveObjectReadBinding): Promise<Uint8Array | undefined> {
    return fetchDurableMeshHistoryObject({ ...this.historyReadContext(workspaceId), baselineId, objectId, binding })
  }

  fetchHistoryBaseline(workspaceId: string, baselineId: string) { return fetchDurableMeshHistoryBaseline({ ...this.historyReadContext(workspaceId), baselineId }) }

  async fetchHistoryDocument(workspaceId: string, descriptor: PeerHistoryBaselineDescriptor) {
    return fetchDurableMeshHistoryDocument({ ...this.historyReadContext(workspaceId), descriptor })
  }

  private historyReadContext(workspaceId: string) {
    return { workspaceId, currentRunId: () => this.currentRunId, isRunning: () => !this.stopped,
      sessions: () => [...this.sessions.values()],
      isCurrent: (entry: SessionEntry, runId: number) => this.currentRunId === runId &&
        this.sessions.get(this.peerKey(workspaceId, entry.deviceId, entry.instanceId)) === entry,
      readAuthority: () => readDurableMeshTransferAuthority({ workspaceId, getProfile: () => this.options.getProfile(),
        store: this.store, revokedWorkspaceIds: (credentials, profile) => this.revokedWorkspaceIds(credentials, profile) }) }
  }

  protected async publishCurrentSession(key: string, entry: SessionEntry, failureCause = "recovery publish failed") {
    try {
      await entry.session.publish()
    } catch (error) {
      const networkFailure = this.recordRouteFailure(key, error)
      if (!networkFailure) this.report(`Publish ${entry.deviceId.slice(0, 6)}`, error)
      await entry.evict(failureCause)
    }
  }

  protected async publishAll() {
    const started = performance.now()
    this.trace("workspace.publish.requested", { workspaceId: "*", source: "all" })
    try {
      const workspaceIds = [...new Set([...this.sessions.values()].map(entry => entry.workspaceId))]
      await Promise.allSettled(workspaceIds.map(workspaceId => this.publishWorkspace(workspaceId)))
    } finally {
      this.trace("workspace.publish.completed", {
        workspaceId: "*", source: "all", elapsedMs: Math.round(performance.now() - started),
      })
    }
  }

  protected publishWorkspace(workspaceId: string): Promise<void> {
    this.trace("workspace.publish.requested", { workspaceId: workspaceId, source: "scoped" })
    const active = this.workspacePublishTasks.get(workspaceId)
    if (active) {
      this.dirtyWorkspacePublishes.add(workspaceId)
      this.trace("workspace.publish.coalesced", { workspaceId: workspaceId })
      return active
    }
    const task = (async () => {
      do {
        this.dirtyWorkspacePublishes.delete(workspaceId)
        const sessions = [...this.sessions.entries()].filter(([, entry]) => entry.workspaceId === workspaceId)
        const started = performance.now()
        this.trace("workspace.publish.started", { workspaceId: workspaceId, sessions: sessions.length })
        try {
          await Promise.allSettled(sessions.map(([key, entry]) => this.publishCurrentSession(key, entry, "publish failed")))
          try { await this.broadcastWorkspaceGossip(workspaceId) }
          catch (error) {
            this.trace("gossip.broadcast.failed", {
              workspaceId: workspaceId, reason: error instanceof Error ? error.message : String(error),
            }, "warn")
          }
        } finally {
          this.trace("workspace.publish.completed", {
            workspaceId: workspaceId, source: "scoped", sessions: sessions.length,
            elapsedMs: Math.round(performance.now() - started),
          })
        }
      } while (this.dirtyWorkspacePublishes.has(workspaceId))
    })().finally(() => {
      this.workspacePublishTasks.delete(workspaceId)
      this.dirtyWorkspacePublishes.delete(workspaceId)
    })
    this.workspacePublishTasks.set(workspaceId, task)
    return task
  }

  protected recordRouteFailure(key: string, error: unknown): boolean {
    const networkFailure = isMeshNetworkFailure(error)
    this.reconnectPolicy.recordFailure(key, networkFailure)
    this.runtime().scheduleReconnect(key, Date.now(), 1_000, 10_000)
    return networkFailure
  }

  async views(workspaceId?: string): Promise<MeshPeerView[]> {
    return (await this.store.listPeers(workspaceId)).map(peer => {
      const payload = (peer.advertisement as WorkspaceMemberBundle | undefined)?.advertisement?.payload
      const online = this.runtimeState?.connectedDevices(peer.workspaceId).includes(peer.deviceId) ?? false
      return {
        workspaceId: peer.workspaceId, personId: peer.personId, deviceId: peer.deviceId, role: peer.role,
        endpoint: peer.endpoint, lastSeen: peer.lastSeen, revokedAt: peer.revokedAt,
        online,
        instances: Math.max(1, peer.instances?.length ?? 0),
        ...(payload?.deviceName ? { deviceName: payload.deviceName } : {}),
        ...(payload?.userAgent ? { userAgent: payload.userAgent } : {}),
      }
    })
  }

  async revokedWorkspaceIds(credentials?: WorkspaceMeshCredential[], profile?: LocalProfile): Promise<string[]> {
    profile ??= await this.options.getProfile()
    const result: string[] = []
    for (const credential of credentials ?? await this.store.listWorkspaceCredentials()) {
      if (hasLeftWorkspace(credential, profile.identity.personId, credential.localGrant as WorkspaceGrant | undefined) || isDeviceRevoked(credential, profile.identity.personId, profile.device.deviceId) || isGrantRevoked(credential, profile.identity.personId, credential.localGrant as WorkspaceGrant | undefined)) result.push(credential.workspaceId)
    }
    return result
  }

  async successionViews(credentials?: WorkspaceMeshCredential[]): Promise<MeshSuccessionView[]> {
    const result: MeshSuccessionView[] = []
    for (const credential of credentials ?? await this.store.listWorkspaceCredentials()) {
      const summary = meshRustRuntime().state.summarizeSuccession(
        successionPolicy(credential), successionClaims(credential), successionVotes(credential), ownershipTransfers(credential),
        revocations(credential), credential.epoch,
      ) as { successorPersonId: string | null; eligibleEditorPersonIds: string[];
        votes: Array<{ voterPersonId: string; candidatePersonId: string }>; quorum: number; conflicted: boolean } | null
      if (!summary) continue
      result.push({
        workspaceId: credential.workspaceId,
        successorPersonId: summary.successorPersonId,
        eligibleEditorPersonIds: summary.eligibleEditorPersonIds,
        votes: summary.votes,
        quorum: summary.quorum,
        conflicted: summary.conflicted,
      })
    }
    return result
  }

  protected async notify() {
    const workspaces = [...new Set([...this.sessions.values()].map(entry => entry.workspaceId))]
    const [peers, credentials, authorityResult, profile] = await Promise.all([
      this.views(), this.store.listWorkspaceCredentials(),
      this.store.listWorkspaceAuthorities().then(authorities => ({ authorities }), () => ({ authorities: null })),
      this.options.getProfile(),
    ])
    const [revoked, succession] = await Promise.all([
      this.revokedWorkspaceIds(credentials, profile), this.successionViews(credentials),
    ])
    const fingerprint = authorityResult.authorities
      ? workspaceAuthorityFingerprint(credentials, authorityResult.authorities)
      : `authority-read-failed:${++this.authorityReadFailure}`
    this.options.onChange?.(workspaces, peers, revoked, succession, fingerprint)
  }
}
