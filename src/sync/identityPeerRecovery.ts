import { createDeviceEnrollmentInvite, createPairingSecret, decodePairingFrame, encodePairingFrame,
  inspectPairingFrame } from "@meta-uber/mesh-pairing"
import { meshNetworkConnection } from "@meta-uber/mesh-transport"
import { captureIdentityProfile, canonicalizeJson, type LocalProfile } from "../domain/identity"
import { defaultStorage } from "../storage"
import { meshIngressBudgetProfile } from "../iroh"
import { getIdentityReplicaConfigurations } from "./privateReplicaRepository"
import { subscribeIdentityDevicePreferences } from "./identityDevicePreferenceEvents"
import { readIdentityPeerRecovery, saveIdentityPeerRecovery, type IdentityPeerRecoverySource } from "./identityPeerRecoveryCatalog"
import { readIdentityWorkspaceRouteRecovery, restoreIdentityWorkspaceRoutes } from "./identityWorkspaceRouteRecovery"
import { peerStore } from "./peerStore"
import { createEnrollmentRequest, readEnrollmentRequest } from "./enrollment"
import { receiveApprovedIdentityWorkspace, serveApprovedIdentityWorkspace } from "./deviceSyncSamePersonWorkspace"
import { startPersistentNode } from "./persistentNode"
import { meshTrace } from "./meshTrace"
import type { DurableMesh } from "./durableMesh"
import type { SyncAcceptor, SyncConnection, SyncNode, SyncTransport } from "./transport"
import type { WorkspaceSetStore } from "./workspaceSet"

type Options = {
  transport: SyncTransport
  store: WorkspaceSetStore
  mesh: DurableMesh
  getProfile(): Promise<LocalProfile>
  ownedWorkspaces(): Promise<{ id: string; title: string }[]>
  changed(): Promise<void>
}

/** Private catalog discovers a source; the existing signed same-person bootstrap carries board history. */
export class IdentityPeerRecovery {
  private node?: SyncNode
  private acceptor?: SyncAcceptor
  private profile?: LocalProfile
  private generation = 0
  private sources: IdentityPeerRecoverySource[] = []
  private connections = new Set<SyncConnection>()
  private timer?: ReturnType<typeof setInterval>
  private unsubscribe?: () => void
  private pending?: Promise<void>
  private starting?: Promise<void>
  private retryAt = new Map<string, number>()

  constructor(private readonly options: Options) {}

  start(): Promise<void> {
    return this.starting ??= this.startNow().finally(() => { this.starting = undefined })
  }

  private async startNow() {
    const initialGeneration = this.generation
    const profile = captureIdentityProfile(await this.options.getProfile())
    if (initialGeneration !== this.generation) return
    if (this.profile && this.sameProfile(profile) && this.node) { await this.publishSources(); return }
    await this.close()
    const generation = ++this.generation
    if (!(await getIdentityReplicaConfigurations(profile.identity.personId)).some(config => !config.removalPending) || generation !== this.generation) return
    const node = await startPersistentNode(this.options.transport, undefined, `identity-recovery-${crypto.randomUUID()}`)
    if (generation !== this.generation) { await node.close("Identity recovery superseded"); return }
    this.profile = profile
    this.node = node
    const acceptor = await node.accept()
    if (generation !== this.generation) { await acceptor.close(); await node.close("Identity recovery superseded"); return }
    this.acceptor = acceptor
    await this.publishSources()
    if (generation !== this.generation) return
    this.unsubscribe = subscribeIdentityDevicePreferences(personId => {
      if (personId === profile.identity.personId) void this.retry().catch(error => this.failed(error))
    })
    this.timer = setInterval(() => { void this.retry().catch(error => this.failed(error)) }, 15_000)
    void this.accept(generation).catch(error => this.failed(error))
  }

  private sameProfile(profile: LocalProfile): boolean {
    return canonicalizeJson({ identity: profile.identity, device: profile.device, certificate: profile.certificate }) ===
      canonicalizeJson({ identity: this.profile?.identity, device: this.profile?.device, certificate: this.profile?.certificate })
  }

  private current(generation: number, profile: LocalProfile): boolean {
    return this.generation === generation && this.profile === profile && !!this.node
  }

  private async publishSources() {
    if (!this.node || !this.profile) return
    const owned = await this.options.ownedWorkspaces()
    const now = Date.now()
    const profile = this.profile
    const endpoint = this.node.endpointId
    const next = owned.map(workspace => this.sources.find(source => source.workspaceId === workspace.id &&
      Date.parse(source.invite.expiresAt) > now + 5 * 60_000) ?? { workspaceId: workspace.id,
      invite: createDeviceEnrollmentInvite(endpoint, createPairingSecret(), profile) })
    if (canonicalizeJson(next) === canonicalizeJson(this.sources)) return
    this.sources = next
    await saveIdentityPeerRecovery(profile.identity.personId, next)
  }

  private async retry() {
    if (this.pending) return this.pending
    this.pending = (async () => {
      if (!this.profile || !this.sameProfile(await this.options.getProfile())) { await this.start(); return }
      await this.publishSources()
      const root = await defaultStorage.loadPersonalRoot()
      if (root?.identity.personId !== this.profile?.identity.personId) return
      await this.recoverNow(Object.values(root.workspaces).filter(reference => !reference.forgotten).map(reference => reference.workspaceId))
    })().finally(() => { this.pending = undefined })
    return this.pending
  }

  async recover(workspaceIds: string[], options: { routesOnly?: boolean } = {}): Promise<void> {
    await this.start()
    if (options.routesOnly) return this.recoverNow(workspaceIds, true)
    if (this.pending) await this.pending
    else this.retryAt.clear()
    this.pending = this.recoverNow(workspaceIds).finally(() => { this.pending = undefined })
    await this.pending
  }

  private async recoverNow(workspaceIds: string[], routesOnly = false) {
    const profile = this.profile
    const node = this.node
    if (!profile || !node) return
    const generation = this.generation
    const isCurrent = () => this.current(generation, profile)
    const candidates = await readIdentityPeerRecovery(profile.identity.personId)
    const routeRecovery = await readIdentityWorkspaceRouteRecovery(profile.identity.personId)
    for (const workspaceId of new Set(workspaceIds)) {
      if (!isCurrent()) return
      try {
        await restoreIdentityWorkspaceRoutes({ mesh: this.options.mesh, envelopes: routeRecovery.envelopes,
          workspaceIds: [workspaceId], profile, readCredential: id => peerStore.getWorkspaceCredential(id) })
      } catch (error) {
        meshTrace("identity.workspace-routes.pending", { workspaceId,
          reason: error instanceof Error ? error.message : String(error) }, "warn")
      }
      if (routesOnly) continue
      try { await this.options.store.read(workspaceId); continue }
      catch { /* A catalog reference is not a retained board copy. */ }
      for (const source of candidates.filter(source => source.workspaceId === workspaceId &&
        source.invite.issuerDeviceId !== profile.device.deviceId && source.invite.issuerPersonId === profile.identity.personId)) {
        if ((this.retryAt.get(source.invite.invitationId) ?? 0) > Date.now()) continue
        try {
          await this.withConnection(async () => meshNetworkConnection(await node.dial(source.invite.issuerEndpoint), meshIngressBudgetProfile()),
            async (connection, active) => {
              const stream = await connection.openStream()
              await stream.send(encodePairingFrame("enroll-request", source.invite.secret, await createEnrollmentRequest(source.invite, profile)))
              await stream.closeSend()
              const bytes = decodePairingFrame(await stream.read(), "enroll-approved", source.invite.secret)
              await receiveApprovedIdentityWorkspace({ profile, mesh: this.options.mesh, store: this.options.store,
                connection, invite: source.invite, bytes, expectedWorkspaceId: workspaceId, getProfile: this.options.getProfile,
                isCurrent: () => isCurrent() && active(),
                received: async receivedId => {
                  if (receivedId !== workspaceId) throw new Error("Identity peer returned another workspace")
                  await this.options.changed()
                } })
            })
          meshTrace("identity.peer-recovery.completed", { workspaceId, sourceDeviceId: source.invite.issuerDeviceId })
          break
        } catch (error) {
          this.retryAt.set(source.invite.invitationId, Date.now() + 30_000)
          meshTrace("identity.peer-recovery.pending", { workspaceId, reason: error instanceof Error ? error.message : String(error) }, "warn")
        }
      }
    }
  }

  private async accept(generation: number) {
    while (this.acceptor && generation === this.generation) {
      const raw = await this.acceptor.accept()
      if (!raw) return
      const connection = meshNetworkConnection(raw, meshIngressBudgetProfile())
      if (this.connections.size >= 2) { await connection.close(); continue }
      void this.withConnection(async () => connection, async (peer, active) => {
        const profile = this.profile!
        const stream = await peer.acceptStream()
        const frame = await stream.read()
        const header = inspectPairingFrame(frame)
        const source = this.sources.find(source => source.invite.secret === header.secret && Date.parse(source.invite.expiresAt) > Date.now())
        if (header.type !== "enroll-request" || !source) throw new Error("Unknown Identity recovery invitation")
        const guest = await readEnrollmentRequest(decodePairingFrame(frame, "enroll-request", source.invite.secret), source.invite)
        if (!guest.identityAuthorityView) throw new Error("Recovery requires an already approved Identity device")
        const workspace = (await this.options.ownedWorkspaces()).find(workspace => workspace.id === source.workspaceId)
        if (!workspace) throw new Error("Source no longer owns this workspace")
        await serveApprovedIdentityWorkspace({ profile, workspace, mesh: this.options.mesh, store: this.options.store,
          stream, connection: peer, invite: source.invite, guest, getProfile: this.options.getProfile,
          isCurrent: () => this.current(generation, profile) && active() })
      }).catch(error => this.failed(error))
    }
  }

  private async withConnection(open: () => Promise<SyncConnection>, operation: (connection: SyncConnection, active: () => boolean) => Promise<void>) {
    let connection: SyncConnection | undefined
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectDeadline: (error: Error) => void = () => {}
    const timeout = () => { expired = true; rejectDeadline(new Error("Identity peer recovery timed out; retry remains available")) }
    try {
      await Promise.race([(async () => {
        connection = await open()
        if (expired) { await connection.close(); return }
        this.connections.add(connection)
        if (timer) clearTimeout(timer)
        timer = setTimeout(timeout, 120_000)
        await operation(connection, () => !expired && this.connections.has(connection!))
      })(), new Promise<never>((_, reject) => {
        rejectDeadline = reject
        timer = setTimeout(timeout, 15_000)
      })])
    } finally {
      if (timer) clearTimeout(timer)
      if (connection) { this.connections.delete(connection); await connection.close().catch(() => {}) }
    }
  }

  private failed(error: unknown) {
    meshTrace("identity.peer-recovery.failed", { reason: error instanceof Error ? error.message : String(error) }, "warn")
  }

  async close() {
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    const node = this.node
    const acceptor = this.acceptor
    this.node = undefined
    this.acceptor = undefined
    this.profile = undefined
    this.sources = []
    await Promise.all([...this.connections].map(connection => connection.close().catch(() => {})))
    this.connections.clear()
    await acceptor?.close().catch(() => {})
    await node?.close("Identity recovery closed").catch(() => {})
  }
}
