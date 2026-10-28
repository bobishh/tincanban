import { deviceManagementActions, ownedWorkspaceIds } from "./deviceManagementActions"
import { computed, ref, type Ref } from "vue"
import { parseInvitation, type ScopedInvitation } from "@meta-uber/mesh-pairing"
import { irohTransport } from "./irohTransport"
import { deriveTranscriptAuthCode } from "./invitations"
import { bootstrapIdentity, type LocalProfile } from "../domain/identity"
import { canReconnectDevice, reconnectWorkspaceDevice, showWorkspaceJoinStep } from "./deviceReconnection"
import type { SyncNode, SyncTransport } from "./transport"
import { type LiveWorkspaceSync, type WorkspaceReplica, type WorkspaceSetStore } from "./workspaceSet"
import type { DurableMesh, DurableMeshOptions, MeshPeerView, MeshSuccessionView } from "./durableMesh"
import { createDeviceSyncState, userMessage } from "./deviceSyncState"
import type { selectDeviceEnrollment } from "./deviceSyncEnrollment"
import { requestDeviceEnrollmentLazily, selectDeviceEnrollmentLazily, lazyIdentityPeerRecovery } from "./lazyDeviceEnrollment"
import { WorkspaceAdmissionFailure } from "./workspaceAdmissionFailure"
import type { WorkspaceHostContext } from "./deviceSyncHost"
import { createKeeperOperations } from "./keeperOperations"
import type { KeeperDiscovery } from "./keeperDiscovery"
import type { KeeperPairing } from "./keeperPairing"
import type { BlobDescriptor } from "@meta-uber/mesh-blob"
import { connectWorkspaceJoin, isWorkspacePairingLocation, reportWorkspaceJoinFailure } from "./workspaceJoinBrowserView"
import { clearPairingLocation, copyInviteLink } from "./deviceSyncInviteView"
import { recoverLiveSession } from "./deviceSyncLiveRecovery"
import { meshTrace } from "./meshTrace"
import { createDeviceSyncJoinApproval } from "./deviceSyncJoinApproval"
import { AuthorityFingerprintTracker } from "./authorityFingerprint"
import { createPeerHistoryReadActions } from "./peerHistoryRequestRouting"
import { createDeviceSyncOwnerReconnect, type OwnerReconnectAdapter } from "./deviceSyncOwnerReconnect"
export type DeviceSyncOptions = {
  workspace: WorkspaceReplica
  workspaceStore?: WorkspaceSetStore
  origin: () => string
  transport?: SyncTransport
  availableWorkspaces?: Ref<{ id: string; title: string }[]>
  activeWorkspaceId?: () => string
  displayName?: () => string
  identityChanged?: () => Promise<void>
  workspaceOwner?: (id: string) => Promise<string>
  ownerReconnect?: OwnerReconnectAdapter
}

export function createDeviceSyncController(options: DeviceSyncOptions) { return new DeviceSyncController(options).api() }

export class DeviceSyncController {
  private readonly state = createDeviceSyncState()
  private readonly joinApproval = createDeviceSyncJoinApproval(this.state)
  private readonly workspace: WorkspaceReplica
  private readonly workspaceStore?: WorkspaceSetStore
  private readonly meshWorkspaceStore?: WorkspaceSetStore
  private readonly origin: () => string
  private readonly transport: SyncTransport
  private readonly availableWorkspaces: Ref<{ id: string; title: string }[]>
  private readonly activeWorkspaceId?: () => string
  private readonly workspaceOwner?: (id: string) => Promise<string>
  private readonly displayName?: () => string
  private readonly identityChanged?: () => Promise<void>
  private readonly ownerReconnectFlow: ReturnType<typeof createDeviceSyncOwnerReconnect>
  private readonly leavingWorkspaceIds = new Set<string>()
  private readonly directPeerSessions = new Map<string, LiveWorkspaceSync>()
  private readonly markNetworkOnline = () => { this.state.networkOnline.value = true }
  private readonly markNetworkOffline = () => { this.state.networkOnline.value = false }
  private node: SyncNode | undefined
  private liveSession: LiveWorkspaceSync | undefined
  private stopWatchingWorkspace: (() => void) | undefined
  private run = 0
  private wakeRetry: (() => void) | undefined
  private approveResolve: ((approved: boolean) => void) | undefined
  private readonly identityPeerRecovery: ReturnType<typeof lazyIdentityPeerRecovery>
  private durableMesh?: DurableMesh
  private durableMeshPromise?: Promise<DurableMesh | undefined>
  private readonly authorityFingerprint = new AuthorityFingerprintTracker(); private readonly keeperOperations = createKeeperOperations(() => this.ensureDurableMesh(), () => this.workspaceHostContext())

  constructor(options: DeviceSyncOptions) {
    this.workspace = options.workspace; this.workspaceStore = options.workspaceStore
    this.origin = options.origin; this.transport = options.transport ?? irohTransport
    this.availableWorkspaces = options.availableWorkspaces ?? ref([]); this.activeWorkspaceId = options.activeWorkspaceId
    this.workspaceOwner = options.workspaceOwner; this.displayName = options.displayName; this.identityChanged = options.identityChanged
    this.ownerReconnectFlow = createDeviceSyncOwnerReconnect({ state: this.state, origin: this.origin, availableWorkspaces: this.availableWorkspaces,
      activeWorkspaceId: this.activeWorkspaceId, workspaceOwner: this.workspaceOwner, store: () => this.meshWorkspaceStore ?? this.workspaceStore,
      getProfile: () => this.getProfile(), ensureDurableMesh: () => this.ensureDurableMesh(), adapter: options.ownerReconnect, nextRun: () => ++this.run, currentRun: () => this.run })
    this.meshWorkspaceStore = this.workspaceStore ? { ...this.workspaceStore } : undefined
    this.identityPeerRecovery = lazyIdentityPeerRecovery(() => this.enrollmentContext(), () => this.ensureDurableMesh())
    if (typeof window !== "undefined") this.listenForNetworkChanges()
  }

  private async ensureDurableMesh(): Promise<DurableMesh | undefined> {
    if (this.durableMesh) return this.durableMesh
    const store = this.meshWorkspaceStore
    if (!this.workspaceStore || !store) return undefined
    if (!this.durableMeshPromise) {
      this.durableMeshPromise = import("./durableMesh").then(({ DurableMesh }) => {
        if (this.durableMesh) return this.durableMesh
        this.durableMesh = new DurableMesh(this.meshOptions(store))
        this.attachMeshStore()
        return this.durableMesh
      }).catch(error => {
        this.durableMeshPromise = undefined
        throw error
      })
    }
    return this.durableMeshPromise
  }

  private meshOptions(store: WorkspaceSetStore): DurableMeshOptions {
    return {
      transport: this.transport, workspaceStore: store, workspace: this.workspace,
      getProfile: () => this.getProfile(),
      onChange: (ids, peers, revoked, succession, fingerprint) => this.updateMeshState(ids, peers, revoked, succession, fingerprint),
      onDiagnostic: message => { this.state.meshDiagnostic.value = message },
      onRetryChange: retryAtByWorkspace => { this.state.meshRetryAt.value = retryAtByWorkspace },
      networkOnline: () => this.state.networkOnline.value,
      getOwnedWorkspaceIds: () => this.getOwnedWorkspaceIds(),
    }
  }

  private updateMeshState(ids: string[], peers: MeshPeerView[], revoked: string[], succession: MeshSuccessionView[], fingerprint: string) {
    this.state.meshLiveWorkspaceIds.value = [...new Set(ids)].filter(id => !this.leavingWorkspaceIds.has(id))
    this.state.meshPeers.value = peers.filter(peer => !this.leavingWorkspaceIds.has(peer.workspaceId))
    this.state.revokedWorkspaceIds.value = revoked.filter(id => !this.leavingWorkspaceIds.has(id))
    this.state.meshSuccession.value = succession.filter(item => !this.leavingWorkspaceIds.has(item.workspaceId))
    if (this.authorityFingerprint.update(fingerprint)) this.state.ownershipRevision.value += 1
    if (ids.length > 0 && this.state.step.value === "workspace-reconnecting") this.state.step.value = "members"
    this.keeperOperations.traceProjection(peers)
  }

  private attachMeshStore() {
    this.meshWorkspaceStore!.readMesh = id => this.durableMesh!.exportWorkspace(id)
    this.meshWorkspaceStore!.mergeMesh = (id, value) => this.durableMesh!.mergeWorkspace(id, value)
  }

  private listenForNetworkChanges() {
    window.addEventListener("online", this.markNetworkOnline)
    window.addEventListener("offline", this.markNetworkOffline)
  }

  private async getOwnedWorkspaceIds() {
    return ownedWorkspaceIds(this.availableWorkspaces.value, this.workspaceOwner, (await this.getProfile()).identity.personId,
      (workspace, error) => {
        const detail = error instanceof Error ? error.message : String(error)
        this.state.meshDiagnostic.value = `Workspace ${workspace.title ?? workspace.id} (${workspace.id}) unavailable: ${detail}`
      })
  }

  private async stopNode(reason: string) {
    this.approveResolve?.(false)
    this.approveResolve = undefined
    this.joinApproval.cancelPending()
    this.stopWatchingWorkspace?.()
    this.stopWatchingWorkspace = undefined
    const session = this.liveSession
    this.liveSession = undefined
    this.state.directLive.value = false
    this.state.liveWorkspaceIds.value = []
    const current = this.node
    this.node = undefined
    await session?.close().catch(error => {
      meshTrace("live.session.cleanup.failed", { reason: userMessage(error, "Session cleanup failed") }, "warn")
    })
    await current?.close(reason).catch(() => {})
  }

  private async pauseDurableMesh() { await this.durableMesh?.pauseAll() }

  private async startDurableMesh(adoptedNode?: SyncNode) {
    const mesh = await this.ensureDurableMesh()
    this.state.revokedWorkspaceIds.value = await mesh?.revokedWorkspaceIds() ?? []
    this.state.isEnabled.value = true; await mesh?.resumeAll(adoptedNode)
    void this.identityPeerRecovery.start()
  }

  private async stopLiveSync() {
    this.state.isEnabled.value = false
    this.run += 1
    this.wakeRetry?.()
    await this.identityPeerRecovery.close(); await this.pauseDurableMesh()
    await this.stopNode("Live sync stopped")
    for (const session of this.directPeerSessions.values()) await session.close().catch(() => {})
    this.directPeerSessions.clear()
    this.state.meshLiveWorkspaceIds.value = []
    this.state.meshRetryAt.value = {}
    this.state.meshDiagnostic.value = ""
  }

  private async handoffDirectNode(reason: string) {
    const adoptedNode = this.node
    this.node = undefined
    await this.stopNode(reason)
    await this.startDurableMesh(adoptedNode)
  }

  private async addOwnerWorkspace(workspaceId: string) { await (await this.ensureDurableMesh())?.addOwnerWorkspace(workspaceId); await this.identityPeerRecovery.start() }

  private async shutdown() {
    this.run += 1
    this.wakeRetry?.(); await this.ownerReconnectFlow.close()
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.markNetworkOnline)
      window.removeEventListener("offline", this.markNetworkOffline)
    }
    await this.identityPeerRecovery.close(true); await (this.durableMesh ?? await this.durableMeshPromise)?.dispose()
    await this.stopNode("Page closed")
  }

  private async revokePeer(personId: string) {
    const workspaceId = this.activeWorkspaceId?.()
    if (!workspaceId) throw new Error("No active workspace")
    await (await this.ensureDurableMesh())?.revokePerson(workspaceId, personId)
    await this.liveSession?.publish().catch(() => {})
    const direct = this.directPeerSessions.get(personId)
    this.directPeerSessions.delete(personId)
    await direct?.close()
  }

  private keeperOperationOptions() { return { getProfile: () => this.getProfile(), workspaces: this.availableWorkspaces.value, workspaceOwner: this.workspaceOwner, mesh: () => this.ensureDurableMesh(), activeWorkspaceId: this.activeWorkspaceId?.(), changed: () => { this.state.ownershipRevision.value++ }, peers: () => this.state.meshPeers.value } }

  private async withActiveWorkspace(action: (workspaceId: string, mesh: DurableMesh) => Promise<void>, changeOwnership = false) {
    const workspaceId = this.activeWorkspaceId?.()
    const mesh = await this.ensureDurableMesh()
    if (!workspaceId || !mesh) throw new Error("No active workspace")
    await action(workspaceId, mesh)
    if (changeOwnership) this.state.ownershipRevision.value += 1
  }

  private async leaveMesh() {
    const workspaceId = this.activeWorkspaceId?.()
    const mesh = await this.ensureDurableMesh()
    if (!workspaceId || !mesh) throw new Error("No active workspace")
    await mesh.leaveWorkspace(workspaceId)
    this.run += 1
    this.wakeRetry?.()
    this.beforeLeaveWorkspace(workspaceId)
    try {
      await this.pauseDurableMesh()
      await this.stopNode("Leaving workspace mesh")
      for (const session of this.directPeerSessions.values()) await session.close().catch(() => {})
      this.directPeerSessions.clear()
      await this.startDurableMesh()
    } finally { this.leavingWorkspaceIds.delete(workspaceId) }
  }

  private async leaveWorkspace(workspaceId: string) {
    if (workspaceId === this.activeWorkspaceId?.()) {
      await this.leaveMesh()
      return
    }
    const mesh = await this.ensureDurableMesh()
    if (!mesh) throw new Error("Mesh unavailable")
    this.beforeLeaveWorkspace(workspaceId)
    try { await mesh.leaveWorkspace(workspaceId) }
    finally { this.leavingWorkspaceIds.delete(workspaceId) }
  }

  private beforeLeaveWorkspace(workspaceId: string) {
    this.leavingWorkspaceIds.add(workspaceId)
    this.state.directLive.value = false
    this.state.liveWorkspaceIds.value = this.state.liveWorkspaceIds.value.filter(id => id !== workspaceId)
    this.state.meshLiveWorkspaceIds.value = this.state.meshLiveWorkspaceIds.value.filter(id => id !== workspaceId)
    this.state.meshPeers.value = this.state.meshPeers.value.filter(peer => peer.workspaceId !== workspaceId)
    this.state.revokedWorkspaceIds.value = this.state.revokedWorkspaceIds.value.filter(id => id !== workspaceId)
    this.state.meshDiagnostic.value = ""
    this.state.ownershipRevision.value += 1
    this.state.step.value = "members"
  }

  private attachLiveSession(session: LiveWorkspaceSync, currentRun: number) {
    this.liveSession = session
    this.state.directLive.value = true
    this.stopWatchingWorkspace = this.workspace.subscribe?.(() => { void this.publishLiveSession(session, currentRun) })
    void session.done.catch(syncError => this.liveSessionFailed(syncError, currentRun))
  }

  private async publishLiveSession(session: LiveWorkspaceSync, currentRun: number) {
    try { await session.publish() } catch (syncError) { this.liveSessionFailed(syncError, currentRun) }
  }

  private liveSessionFailed(syncError: unknown, currentRun: number) {
    void recoverLiveSession({ error: syncError, sessionRun: currentRun, currentRun: () => this.run,
      supersede: () => ++this.run, state: this.state,
      terminalError: syncError instanceof WorkspaceAdmissionFailure ? syncError : undefined,
      handoff: () => this.handoffDirectNode("Live sync interrupted") })
  }

  private detachLiveSession(session: LiveWorkspaceSync) {
    this.stopWatchingWorkspace?.()
    this.stopWatchingWorkspace = undefined
    if (this.liveSession === session) this.liveSession = undefined
    this.state.directLive.value = false
  }

  private async close() {
    this.run += 1
    this.wakeRetry?.(); await this.ownerReconnectFlow.close()
    this.state.isOpen.value = false
    this.state.step.value = "idle"
    this.state.qrCode.value = ""
    this.state.inviteUrl.value = ""
    this.state.copyNotice.value = ""
    this.state.error.value = ""
    this.state.authCode.value = ""; this.state.parsedInvite.value = null; this.state.ownerReconnectReview.value = null
    await this.handoffDirectNode("Pairing closed")
  }

  private async dismiss() {
    if (this.state.step.value.startsWith("owner-reconnect-") || this.state.step.value === "error") { clearPairingLocation(); await this.close(); return }
    this.state.isOpen.value = false
  }

  private open() {
    if (["workspace-reconnecting", "workspace-guest-waiting", "enroll-host-preparing", "enroll-host", "enroll-host-pending", "enroll-guest-waiting", "enroll-syncing"].includes(this.state.step.value)) {
      this.state.isOpen.value = true
      return
    }
    this.state.isOpen.value = true
    this.state.step.value = "members"
    this.state.error.value = ""
    this.state.copyNotice.value = ""
    this.state.localUserAgent.value = typeof navigator !== "undefined" ? navigator.userAgent : ""
    this.selectActiveWorkspace()
  }

  private selectActiveWorkspace() {
    const active = this.activeWorkspaceId?.() || this.availableWorkspaces.value[0]?.id
    this.state.selectedWorkspaceIds.value = active ? [active] : []
    this.state.selectedWorkspaceId.value = active ?? ""
  }

  private async getProfile(): Promise<LocalProfile> {
    const profile = await bootstrapIdentity("My Device")
    this.state.localDeviceId.value = profile.device.deviceId; this.state.canRenewDevice.value = Boolean(profile.privateKeys.identityPrivateKey)
    this.state.localUserAgent.value = typeof navigator !== "undefined" ? navigator.userAgent : ""
    return profile
  }

  private enrollmentContext(): Parameters<typeof selectDeviceEnrollment>[0] {
    return {
      state: this.state, workspaceStore: this.workspaceStore, meshWorkspaceStore: this.meshWorkspaceStore,
      durableMesh: this.durableMesh, availableWorkspaces: this.availableWorkspaces.value,
      activeWorkspaceId: this.activeWorkspaceId, workspaceOwner: this.workspaceOwner, origin: this.origin,
      transport: this.transport, getProfile: () => this.getProfile(), nextRun: () => ++this.run,
      currentRun: () => this.run, pauseMesh: () => this.pauseDurableMesh(), stopNode: reason => this.stopNode(reason),
      setNode: node => { this.node = node }, handoffNode: reason => this.handoffDirectNode(reason),
      identityChanged: this.identityChanged, waitToReconnect: milliseconds => this.waitToReconnect(milliseconds),
      setApprovalResolver: resolve => { this.approveResolve = resolve }, denyPendingApproval: () => this.approveResolve?.(false),
    }
  }

  private selectSyncAll() {
    return selectDeviceEnrollmentLazily(() => this.enrollmentContext(), () => this.ensureDurableMesh())
  }

  private selectSyncWorkspace() {
    this.state.step.value = "workspace-select"
    if (this.availableWorkspaces.value.length && this.state.selectedWorkspaceIds.value.length === 0) this.state.selectedWorkspaceIds.value = [this.availableWorkspaces.value[0].id]
  }

  private async generateWorkspaceInvite() {
    const run = this.run
    await this.ensureDurableMesh()
    if (this.run !== run) return
    const { generateWorkspaceInvite } = await import("./deviceSyncHost")
    if (this.run !== run) return
    await generateWorkspaceInvite(this.workspaceHostContext())
  }

  private workspaceHostContext(): WorkspaceHostContext {
    return {
      state: this.state, workspace: this.workspace, workspaceStore: this.workspaceStore, meshWorkspaceStore: this.meshWorkspaceStore,
      durableMesh: this.durableMesh, availableWorkspaces: this.availableWorkspaces.value, workspaceOwner: this.workspaceOwner,
      origin: this.origin, transport: this.transport, getProfile: () => this.getProfile(), nextRun: () => ++this.run,
      currentRun: () => this.run, pauseMesh: () => this.pauseDurableMesh(), stopNode: reason => this.stopNode(reason),
      startMesh: node => this.startDurableMesh(node), setNode: node => { this.node = node }, getNode: () => this.node,
      attachLiveSession: (session, run) => this.attachLiveSession(session, run), detachLiveSession: session => this.detachLiveSession(session),
      waitForJoinDecision: (personId, name, ownerConnection) => this.joinApproval.waitForJoinDecision(personId, name, ownerConnection),
      replaceDirectSession: (personId, session) => this.replaceDirectSession(personId, session),
      removeDirectSession: (personId, session) => this.removeDirectSession(personId, session),
    }
  }

  private replaceDirectSession(personId: string, session: LiveWorkspaceSync) {
    const previous = this.directPeerSessions.get(personId)
    this.directPeerSessions.set(personId, session)
    return previous
  }

  private removeDirectSession(personId: string, session: LiveWorkspaceSync) {
    if (this.directPeerSessions.get(personId) === session) this.directPeerSessions.delete(personId)
  }

  private approveEnrollment() {
    if (this.state.step.value !== "enroll-host-pending") return
    this.approveResolve?.(true)
    this.approveResolve = undefined
  }

  private declineEnrollment() {
    this.approveResolve?.(false)
    this.approveResolve = undefined
  }

  private async prepareJoin(rawInvite: string) {
    await this.close()
    this.state.isOpen.value = true
    try {
      const saved = this.savedWorkspaceInvite(rawInvite)
      if (saved && await this.reopenSavedWorkspace(saved)) return
      const invite = parseInvitation(rawInvite)
      if (invite.kind === "device-enrollment") await import("./enrollmentDiagnostics")
        .then(module => module.captureEnrollmentDiagnosticContext(invite, rawInvite))
      this.state.parsedInvite.value = invite
      await this.showInviteStep(invite)
    } catch (err) {
      this.state.step.value = "error"
      this.state.error.value = userMessage(err, "This pairing link is invalid.")
    }
  }

  private savedWorkspaceInvite(rawInvite: string) {
    try {
      const invite = parseInvitation(rawInvite, Number.NEGATIVE_INFINITY)
      return invite.kind === "workspace-join" ? invite : undefined
    } catch { return undefined }
  }

  private async reopenSavedWorkspace(invite: Extract<ScopedInvitation, { kind: "workspace-join" }>) {
    const ids = invite.workspaces.map(item => item.id)
    const local = ids.every(id => this.availableWorkspaces.value.some(item => item.id === id))
    const known = await (await this.ensureDurableMesh())?.knowsWorkspaceIssuer(
      ids,
      invite.issuerPersonId,
      invite.issuerDeviceId,
    )
    if (!local || !known) return false
    await this.workspaceStore?.activate(ids[0]!)
    clearPairingLocation()
    this.state.isOpen.value = false
    await this.startDurableMesh()
    return true
  }

  private async showInviteStep(invite: ScopedInvitation) {
    if (invite.kind === "owner-reconnect") return this.ownerReconnectFlow.connect(invite)
    if (invite.kind === "device-enrollment") {
      const profile = await this.getProfile()
      this.state.replacementPersonId.value = undefined
      this.state.enrollmentConflict.value = profile.identity.personId === invite.issuerPersonId ? null : {
        currentPersonId: profile.identity.personId, currentName: profile.identity.displayName, targetPersonId: invite.issuerPersonId,
      }
      this.state.step.value = "enroll-guest"
      this.state.authCode.value = await deriveTranscriptAuthCode(invite.secret, invite.invitationId, invite.issuerPublicKey)
      return
    }
    if (invite.kind !== "workspace-join") return
    await showWorkspaceJoinStep(this.state, invite, this.availableWorkspaces.value.map(item => item.id),
      async () => await this.durableMesh?.revokedWorkspaceIds() ?? [])
  }

  private async waitToReconnect(milliseconds: number) {
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer)
        window.removeEventListener("online", finish)
        if (this.wakeRetry === finish) this.wakeRetry = undefined
        resolve()
      }
      const timer = setTimeout(finish, milliseconds)
      this.wakeRetry = finish
      window.addEventListener("online", finish, { once: true })
    })
  }

  private async acceptWorkspaceJoin() {
    const invite = this.state.parsedInvite.value
    if (!invite || invite.kind !== "workspace-join" || this.state.step.value === "workspace-guest-waiting") return
    await this.ensureDurableMesh()
    const run = ++this.run
    await this.pauseDurableMesh()
    this.state.step.value = "workspace-guest-waiting"
    this.state.error.value = ""
    try {
      if (!this.workspaceStore) throw new Error("Workspace sync is unavailable.")
      if (Date.parse(invite.expiresAt) <= Date.now()) throw new Error("This invitation has expired.")
      await connectWorkspaceJoin({
        state: this.state,
        workspace: this.workspace,
        workspaceStore: this.workspaceStore,
        meshWorkspaceStore: this.meshWorkspaceStore,
        durableMesh: this.durableMesh,
        transport: this.transport,
        getProfile: () => this.getProfile(),
        displayName: this.displayName,
        currentRun: () => this.run,
        waitToReconnect: milliseconds => this.waitToReconnect(milliseconds),
        setNode: node => { this.node = node },
        getNode: () => this.node,
        setLiveSession: session => { this.liveSession = session },
        setStopWatching: stop => { this.stopWatchingWorkspace = stop },
        clearPairingLocation,
      }, run, invite)
    } catch (error) {
      reportWorkspaceJoinFailure(this.state, this.run, run, invite, error)
    }
  }

  api() {
    const state = this.state
    return {
      isOpen: state.isOpen, isEnabled: state.isEnabled, pendingJoins: state.pendingJoins, decideJoin: this.joinApproval.decideJoin, ownerReconnectReview: state.ownerReconnectReview,
      isLive: state.isLive, isWorkspaceLive: (id: string) => (state.directLive.value && state.liveWorkspaceIds.value.includes(id)) || state.meshLiveWorkspaceIds.value.includes(id),
      isWorkspaceAccessRevoked: (id: string) => state.revokedWorkspaceIds.value.includes(id), meshPeers: state.meshPeers, meshDiagnostic: state.meshDiagnostic,
      meshRetryAt: state.meshRetryAt, networkOnline: state.networkOnline, meshSuccession: state.meshSuccession, localDeviceId: state.localDeviceId,
      localUserAgent: state.localUserAgent, ownershipRevision: state.ownershipRevision, step: state.step, phase: state.phase, title: state.title,
      qrCode: state.qrCode, inviteUrl: state.inviteUrl, copyNotice: state.copyNotice, error: state.error, authCode: state.authCode,
      selectedWorkspaceId: state.selectedWorkspaceId, selectedWorkspaceIds: state.selectedWorkspaceIds, invitationWorkspaceTitle: state.invitationWorkspaceTitle,
      invitationWorkspaces: state.invitationWorkspaces, availableWorkspaces: this.availableWorkspaces, open: () => this.open(),
      selectSyncAll: () => this.selectSyncAll(), selectSyncWorkspace: () => this.selectSyncWorkspace(), generateWorkspaceInvite: () => this.generateWorkspaceInvite(),
      startOwnerReconnect: () => this.ownerReconnectFlow.startHost(), approveOwnerReconnect: () => this.ownerReconnectFlow.approve(),
      cancelOwnerReconnect: async () => { await this.ownerReconnectFlow.cancel(); await this.dismiss() },
      provisionKeeperPairing: this.keeperOperations.provision,
      cancelKeeperPairing: async (pairing: KeeperPairing, operationId: string) => (await import("./keeperPairingWithdrawal")).cancelKeeperPairing(pairing, operationId, () => this.ensureDurableMesh()),
      approveEnrollment: () => this.approveEnrollment(), declineEnrollment: () => this.declineEnrollment(), enrollmentDeviceName: state.enrollmentDeviceName, enrollmentSameIdentity: state.enrollmentSameIdentity, enrollmentConflict: state.enrollmentConflict,
      enrollmentPersonId: computed(() => state.parsedInvite.value?.kind === "device-enrollment" ? state.parsedInvite.value.issuerPersonId : undefined),
      requestEnrollment: (replaceIdentity = false) => requestDeviceEnrollmentLazily(() => this.enrollmentContext(), () => this.ensureDurableMesh(), replaceIdentity), acceptWorkspaceJoin: () => this.acceptWorkspaceJoin(), prepareJoin: (raw: string) => this.prepareJoin(raw),
      canReconnectDevice: computed(() => canReconnectDevice(state)), reconnectDevice: () => reconnectWorkspaceDevice({ state,
        stop: () => this.stopLiveSync(), resetMesh: async () => { await (this.durableMesh ?? await this.durableMeshPromise)?.dispose(); this.durableMesh = undefined; this.durableMeshPromise = undefined },
        identityChanged: this.identityChanged, refreshProfile: () => this.getProfile(), join: () => this.acceptWorkspaceJoin() }),
      joinFromLocation: (raw: string) => isWorkspacePairingLocation(raw, url => { void this.prepareJoin(url) }), startDurableMesh: () => this.startDurableMesh(), recoverIdentityWorkspaces: (ids: string[], options?: { routesOnly?: boolean }) => this.identityPeerRecovery.recover(ids, options), stopLiveSync: () => this.stopLiveSync(), addOwnerWorkspace: (id: string) => this.addOwnerWorkspace(id),
      fetchBlob: async (workspaceId: string, descriptor: BlobDescriptor) => (await this.ensureDurableMesh())?.fetchBlob(workspaceId, descriptor),
      ...createPeerHistoryReadActions({ durableMesh: () => this.durableMesh, durableMeshPromise: () => this.durableMeshPromise,
        directPeerSessions: () => new Set([...this.directPeerSessions.values(), ...(this.liveSession ? [this.liveSession] : [])]) }),
      ...deviceManagementActions(() => this.ensureDurableMesh(), this.availableWorkspaces, this.state.ownershipRevision),
      promotePeer: (personId: string) => this.withActiveWorkspace((id, mesh) => mesh.promotePerson(id, personId), true),
      shutdown: () => this.shutdown(), revokePeer: (personId: string) => this.revokePeer(personId),
      removeKeeper: (personId: string, discovery?: KeeperDiscovery, knownServiceDeviceIds?: string[]) =>
        this.keeperOperations.remove(personId, { ...this.keeperOperationOptions(), discovery, knownServiceDeviceIds }),
      updateKeeperSettings: (personId: string, futureBoards: boolean, removeWorkspaceIds: string[]) =>
        this.keeperOperations.updateSettings(personId, futureBoards, removeWorkspaceIds, this.keeperOperationOptions()),
      beginPolicyUpdate: async (personId: string, baselineWorkspaceIds: string[]) =>
        (await import("./keeperPolicyUpdate")).beginKeeperPolicyUpdate(personId, baselineWorkspaceIds),
      transferOwnership: (personId: string) => this.withActiveWorkspace((id, mesh) => mesh.transferOwnership(id, personId), true),
      setSuccessor: (personId: string | null) => this.withActiveWorkspace((id, mesh) => mesh.setSuccessor(id, personId)), voteForSuccessor: (personId: string) => this.withActiveWorkspace((id, mesh) => mesh.voteForSuccessor(id, personId)),
      claimSuccession: () => this.withActiveWorkspace((id, mesh) => mesh.claimSuccession(id), true), leaveMesh: () => this.leaveMesh(),
      leaveWorkspace: (workspaceId: string) => this.leaveWorkspace(workspaceId), copyInvite: (target?: string) => copyInviteLink(state, target),
      close: () => this.close(), dismiss: () => this.dismiss(),
    }
  }
}
