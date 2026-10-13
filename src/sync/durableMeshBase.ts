import { type LocalProfile} from "../domain/identity"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import { BrowserMeshGossip, MeshReconnectPolicy, MeshDialCancelled, MeshNodeRestart, isMeshDialNetworkFailure } from "@meta-uber/mesh-runtime"
import type { BrowserMeshLifecycle } from "@meta-uber/mesh-runtime"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { createMeshRuntime, type MeshRuntimeState } from "@meta-uber/mesh-runtime"
import type { defaultProofStore } from "../domain/proofs"
import {
  type WorkspaceDeparture, type WorkspaceDeviceRevocation, type WorkspaceAuthority, type WorkspaceMemberBundle, type WorkspaceOwnershipTransfer, type WorkspaceRevocation,
  type WorkspaceSuccessionPolicy, type WorkspaceSuccessionVote, type WorkspaceSuccessionClaim } from "./meshRecords"
import { acquireMeshInstanceLease } from "./meshInstanceLease"
import { meshTrace, type MeshTraceLevel } from "./meshTrace"
import { peerStore, type PeerStore, type WorkspaceMeshCredential} from "./peerStore"
import { startPersistentNode } from "./persistentNode"
import type { SyncAcceptor, SyncConnection, SyncNode, SyncTransport} from "./transport"
import { publishGossipPacket, type LiveWorkspaceSync, type WorkspaceReplica, type WorkspaceSetStore } from "./workspaceSet"
type ScopeSuccessionTransfer = {
  fromControlEpoch: number
  claim: WorkspaceSuccessionClaim
  revocations: WorkspaceRevocation[]
}

export type ScopeAuthoritySnapshot = {
  genesis: unknown
  grants: unknown[]
  grantIssuers: unknown[]
  revocations: unknown[]
  controlTransfers: unknown[]
  successionTransfers?: ScopeSuccessionTransfer[]
}

export type MeshWorkspaceEnvelope = {
  version: 1
  workspaceId: string
  ownerPersonId: string
  ownerPublicKey: string
  ownerCertificates: unknown[]
  transportSecret: string
  epoch: number
  peers: WorkspaceMemberBundle[]
  departures?: WorkspaceDeparture[]
  deviceRevocations?: WorkspaceDeviceRevocation[]
  revocations?: WorkspaceRevocation[]
  ownerHistory?: WorkspaceAuthority[]
  ownershipTransfers?: WorkspaceOwnershipTransfer[]
  successionPolicy?: WorkspaceSuccessionPolicy
  successionVotes?: WorkspaceSuccessionVote[]
  successionClaims?: WorkspaceSuccessionClaim[]
  scopeAuthoritySnapshot?: ScopeAuthoritySnapshot
}

export type MeshExport = {
  version: 1
  peers: WorkspaceMemberBundle[]
  departures?: WorkspaceDeparture[]
  deviceRevocations?: WorkspaceDeviceRevocation[]
  revocations: WorkspaceRevocation[]
  ownershipTransfers?: WorkspaceOwnershipTransfer[]
  successionPolicy?: WorkspaceSuccessionPolicy
  successionVotes?: WorkspaceSuccessionVote[]
  successionClaims?: WorkspaceSuccessionClaim[]
  scopeAuthoritySnapshot?: ScopeAuthoritySnapshot
}

export type MeshPeerView = {
  workspaceId: string
  personId: string
  deviceId: string
  instances?: number
  role: "owner" | "editor" | "visitor"
  endpoint: string
  online: boolean
  lastSeen: string
  revokedAt?: string | null
  deviceName?: string
  userAgent?: string
}

export type MeshSuccessionView = {
  workspaceId: string
  successorPersonId: string | null
  eligibleEditorPersonIds: string[]
  votes: Array<{ voterPersonId: string; candidatePersonId: string }>
  quorum: number
  conflicted: boolean
}

export type SessionEntry = {
  connectionId: string
  workspaceId: string
  deviceId: string
  instanceId: string
  endpoint: string
  remoteIssuedAt: string
  remoteRouteSequence?: number
  direction: "incoming" | "outgoing"
  connection: SyncConnection
  session: LiveWorkspaceSync
  ownershipReceiptSupported?: boolean
  remotePersonId: string
  ownerWorkspaceOfferFrame?: "mesh-owner-workspace-offer"
  blobTransferSupported?: boolean
  runtimeGeneration?: number
  evict: (cause: string) => Promise<void>
}

export type DurableMeshOptions = {
  transport: SyncTransport
  workspaceStore: WorkspaceSetStore
  workspace: WorkspaceReplica
  getProfile: () => Promise<LocalProfile>
  store?: PeerStore
  onChange?: (workspaces: string[], peers: MeshPeerView[], revoked: string[], succession: MeshSuccessionView[], authorityFingerprint: string) => void
  onDiagnostic?: (message: string) => void
  onRetryChange?: (retryAtByWorkspace: Record<string, number>) => void
  networkOnline?: () => boolean
  getOwnedWorkspaceIds?: () => Promise<string[]>
}

export { MeshDialCancelled, MeshNodeRestart, isMeshDialNetworkFailure }

const MESH_INSTANCE_KEY = "tincanban.mesh.instance.v1"

export function uniqueCertificates(profile: LocalProfile, certificates: Awaited<ReturnType<typeof defaultProofStore.listCertificates>>) {
  const all = [profile.certificate, ...certificates]
    .filter(cert => cert?.payload?.personId === profile.identity.personId)
  const seen = new Set<string>()
  return all.filter(cert => {
    const key = `${cert.payload.deviceId}:${cert.signature}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function isEnvelope(value: unknown): value is MeshWorkspaceEnvelope {
  return meshRustRuntime().state.isWorkspaceEnvelope(value, Date.now())
}

export type MeshCatalog = { departures?: WorkspaceDeparture[]; deviceRevocations?: WorkspaceDeviceRevocation[]; revocations?: WorkspaceRevocation[]; ownershipTransfers?: WorkspaceOwnershipTransfer[]
  successionPolicy?: WorkspaceSuccessionPolicy; successionVotes?: WorkspaceSuccessionVote[]; successionClaims?: WorkspaceSuccessionClaim[] }
export const CAUSAL_WRITE_ADMISSION_CAPABILITY = "causal-write-admission-v1"
export function assertRequiredMeshCapabilities(capabilities: unknown): asserts capabilities is string[] {
  meshRustRuntime().state.validateMeshCapabilities(capabilities)
  if (!Array.isArray(capabilities) || !capabilities.includes(CAUSAL_WRITE_ADMISSION_CAPABILITY))
    throw new Error("Peer needs causal write admission support. Upgrade the peer and reconnect.")
}

export function meshCatalog(credential: Pick<WorkspaceMeshCredential, "catalog">): MeshCatalog {
  return (credential.catalog as MeshCatalog | undefined) ?? {}
}

export function revocations(credential: Pick<WorkspaceMeshCredential, "catalog">): WorkspaceRevocation[] {
  const value = meshCatalog(credential)
  return Array.isArray(value?.revocations) ? value.revocations : []
}

export function ownershipTransfers(credential: WorkspaceMeshCredential): WorkspaceOwnershipTransfer[] {
  const value = meshCatalog(credential)
  return Array.isArray(value.ownershipTransfers) ? value.ownershipTransfers : []
}

export function successionPolicy(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionPolicy }
export function successionVotes(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionVotes ?? [] }
export function successionClaims(credential: WorkspaceMeshCredential) { return meshCatalog(credential).successionClaims ?? [] }

export function ownerAuthorities(credential: WorkspaceMeshCredential): WorkspaceAuthority[] {
  return [{ personId: credential.ownerPersonId, publicKey: credential.ownerPublicKey,
    certificates: credential.ownerCertificates as DeviceCertificate[] }, ...((credential.ownerHistory ?? []) as WorkspaceAuthority[])]
}

export function revokedPersonIds(credential: WorkspaceMeshCredential) {
  return new Set(revocations(credential).map(record => record.payload.personId))
}

/** A signed grant issued after a removal has a new access generation. Legacy
 * grants are generation 1, so old persisted documents still verify normally. */
export function isGrantRevoked(credential: WorkspaceMeshCredential, personId: string,
  grant: { payload?: { accessEpoch?: unknown } } | undefined): boolean {
  return meshRustRuntime().state.isGrantRevoked(credential, personId, grant ?? null)
}

export abstract class DurableMeshBase {
  static readonly ROUTE_LEASE_MS = 2 * 60_000
  static readonly ROUTE_RENEW_MS = 60_000
  protected readonly store: PeerStore
  protected node: SyncNode | undefined
  protected acceptor: SyncAcceptor | undefined
  protected sessions = new Map<string, SessionEntry>()
  protected pendingIncomingConnections = 0
  protected runSequence = 0
  protected currentRunId = 0
  protected connectionSequence = 0
  protected lifecycle: BrowserMeshLifecycle | undefined
  protected stopWatch: (() => void) | undefined
  private reconnectPolicyState: MeshReconnectPolicy | undefined
  protected runtimeState: MeshRuntimeState | undefined
  /** Only credentials verified for the current local identity may produce routes. */
  protected activeWorkspaceIds: Set<string> | undefined
  protected readonly runtimeId = crypto.randomUUID()
  protected instanceId = ""
  protected releaseInstance: (() => Promise<void>) | undefined
  protected adoptedNode: SyncNode | undefined
  protected lastDiagnostic = ""
  /** tincanban binds workspace documents to the shared browser gossip lifecycle. */
  protected readonly gossip = new BrowserMeshGossip({
    isStopped: () => this.stopped,
    createEngine: () => this.node?.createGossipEngine(),
    endpoints: workspaceId => [...new Set([...this.sessions.values()]
      .filter(entry => entry.workspaceId === workspaceId && entry.endpoint)
      .map(entry => entry.endpoint))].sort(),
    encodeWorkspaceUpdate: (workspaceId, nonce) => this.runtime().encodeWorkspaceUpdate(workspaceId, nonce),
    isWorkspaceUpdate: (payload, workspaceId) => this.runtime().isWorkspaceUpdate(payload, workspaceId),
    transportSecret: async workspaceId => (await this.store.getWorkspaceCredential(workspaceId))?.transportSecret,
    session: (workspaceId, endpoint) => {
      const entry = [...this.sessions.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.endpoint === endpoint)
      return entry && { endpoint: entry.endpoint, deviceId: entry.deviceId, publish: () => entry.session.publish() }
    },
    send: async (workspaceId, endpoint, secret, packet) => {
      const entry = [...this.sessions.values()].find(candidate => candidate.workspaceId === workspaceId && candidate.endpoint === endpoint)
      if (!entry) throw new Error("Gossip peer session is unavailable")
      await publishGossipPacket(entry.connection, secret, packet)
    },
    publishAll: () => this.publishAll(),
    trace: (event, detail, level) => this.trace(event, detail, level),
  }, "tincanban-workspace-")

  protected get stopped() { return this.lifecycle?.stopped ?? true }
  protected get externallyPaused() { return this.lifecycle?.externallyPaused ?? false }
  protected get disposed() { return this.lifecycle?.disposed ?? false }

  constructor(protected readonly options: DurableMeshOptions) {
    this.store = options.store ?? peerStore
    this.trace("instance.created")
  }

  protected runtime() {
    this.runtimeState ??= createMeshRuntime()
    if (!this.runtimeState.running) this.runtimeState.start()
    return this.runtimeState
  }

  protected get reconnectPolicy() {
    this.reconnectPolicyState ??= new MeshReconnectPolicy(this.runtime())
    return this.reconnectPolicyState
  }

  protected runtimeSessionKey(workspaceId: string, deviceId: string, instanceId: string) {
    return { workspaceId, deviceId, instanceId }
  }

  protected trace(event: string, detail: Record<string, unknown> = {}, level: MeshTraceLevel = "info", error?: unknown) {
    meshTrace(event, { runtimeId: this.runtimeId.slice(0, 8), runId: this.currentRunId, ...detail }, level, error)
  }

  protected async traceSlowPhase<T>(phase: string, workspaceId: string,
    detail: Record<string, unknown>, operation: () => T | Promise<T>): Promise<T> {
    const startedAt = performance.now()
    try { return await operation() }
    finally {
      const elapsedMs = Math.round(performance.now() - startedAt)
      if (elapsedMs >= 250) this.trace("authority.merge.phase", {
        phase, workspaceId: workspaceId, elapsedMs, ...detail,
      }, "warn")
    }
  }

  protected connectionId(direction: "incoming" | "outgoing") {
    this.connectionSequence += 1
    return `${direction === "incoming" ? "in" : "out"}-${this.connectionSequence}`
  }

  protected peerKey(workspaceId: string, deviceId: string, instanceId = "legacy") {
    return `${workspaceId}:${deviceId}:${instanceId}`
  }

  protected routeFailures(key: string): number {
    return this.runtimeState?.reconnectState(key)?.failures ?? 0
  }

  protected clearRouteReconnect(key: string): void {
    this.runtimeState?.clearReconnect(key)
  }

  protected clearRouteReconnects(prefix: string): void {
    this.runtimeState?.clearReconnectsWithPrefix(prefix)
  }

  protected deviceKey(workspaceId: string, deviceId: string) {
    return `${workspaceId}:${deviceId}`
  }

  protected async acquireInstance() {
    if (this.releaseInstance) return
    const preferred = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(MESH_INSTANCE_KEY)
    const lease = await acquireMeshInstanceLease({ preferredInstanceId: preferred })
    this.instanceId = lease.instanceId
    this.releaseInstance = lease.release
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(MESH_INSTANCE_KEY, lease.instanceId)
    this.trace("instance.acquired", { instanceId: lease.instanceId })
  }

  async startInstanceNode(): Promise<SyncNode> {
    await this.acquireInstance()
    return startPersistentNode(this.options.transport, this.store, this.instanceId)
  }

  protected refreshWorkspaceGossip(workspaceId: string): Promise<void> { return this.gossip.refresh(workspaceId) }
  protected async rebuildWorkspaceGossip(workspaceId: string): Promise<void> { await this.gossip.rebuild(workspaceId) }
  protected async receiveWorkspaceGossipPacket(workspaceId: string, endpoint: string, packet: Uint8Array): Promise<void> {
    await this.gossip.receivePacket(workspaceId, endpoint, packet)
  }
  protected async broadcastWorkspaceGossip(workspaceId: string): Promise<Set<string> | undefined> {
    return this.gossip.broadcast(workspaceId)
  }

  protected async peerInstances(workspaceId?: string) {
    const list = (this.store as PeerStore & { listPeerInstances?: PeerStore["listPeerInstances"] }).listPeerInstances
    const peers = list ? await list.call(this.store, workspaceId) : await (this.store as PeerStore & { listPeers?: PeerStore["listPeers"] }).listPeers?.call(this.store, workspaceId) ?? []
    return this.activeWorkspaceIds === undefined ? peers : peers.filter(peer => this.activeWorkspaceIds!.has(peer.workspaceId))
  }

  protected report(stage: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    this.lastDiagnostic = `${stage}: ${detail || "unknown transport error"}`
    this.trace("diagnostic", { stage, reason: detail || "unknown transport error" }, "warn", error)
    this.options.onDiagnostic?.(this.lastDiagnostic)
    void this.notify().catch(error => {
      this.trace("diagnostic.notification.failed", { reason: error instanceof Error ? error.message : String(error) }, "warn")
    })
  }

  protected reportProtocolFailure(stage: string, error: unknown) {
    if (isMeshDialNetworkFailure(error)) {
      void this.notify()
      return
    }
    this.report(stage, error)
  }

  async pauseAll(): Promise<void> {
    await this.lifecycle?.pause()
  }

  async resumeAll(node?: SyncNode): Promise<void> {
    if (this.disposed) return void node?.close("Mesh disposed")
    if (node) {
      await this.adoptedNode?.close("Mesh node replaced").catch(() => {})
      this.adoptedNode = node
    }
    await this.lifecycle?.resume(() => this.start())
  }

  async waitUntilListening(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.disposed && !this.externallyPaused && !this.stopped && (!this.node || !this.acceptor)) {
      if (Date.now() >= deadline) throw new Error("Workspace mesh did not resume in time")
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (this.disposed || this.externallyPaused || this.stopped) {
      throw new Error("Workspace mesh stopped before it resumed")
    }
  }

  async dispose(): Promise<void> {
    await this.lifecycle?.dispose(() => this.stop())
    this.runtimeState?.free?.()
    this.runtimeState = undefined
    this.reconnectPolicyState = undefined
  }

  protected abstract start(): Promise<void>
  protected abstract stop(releaseInstance?: boolean): Promise<void>
  protected abstract notify(): Promise<void>
  protected abstract publishAll(): Promise<void>
  protected abstract publishWorkspace(workspaceId: string): Promise<void>
}

export function deviceRevocations(credential: WorkspaceMeshCredential): WorkspaceDeviceRevocation[] {
  return meshCatalog(credential).deviceRevocations ?? []
}
export function isDeviceRevoked(credential: WorkspaceMeshCredential, personId: string, deviceId: string): boolean {
  return meshRustRuntime().state.isDeviceRevoked(credential, personId, deviceId)
}

export function departures(credential: WorkspaceMeshCredential): WorkspaceDeparture[] { return meshCatalog(credential).departures ?? [] }
export function hasLeftWorkspace(credential: WorkspaceMeshCredential, personId: string, grant?: WorkspaceGrant): boolean {
  return meshRustRuntime().state.hasLeftWorkspace(credential, personId, grant ?? null)
}
