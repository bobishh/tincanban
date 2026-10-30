import {
  createPairingSecret,
  createWorkspaceJoinInvite,
  inspectPairingFrame,
  invitationUrl,
  type WorkspaceJoinInvitation,
} from "@meta-uber/mesh-pairing"
import { defaultInvitationService } from "./invitations"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceGrant } from "../domain/model"
import { isMeshNetworkFailure, meshNetworkConnection, startMeshHeartbeat } from "@meta-uber/mesh-transport"
import { BrowserWorkspaceJoinHandoffHost, BrowserWorkspaceJoinHost } from "@meta-uber/mesh-runtime"
import { WasmWorkspaceJoinHandshake, WasmWorkspaceJoinHandoff } from "../iroh"
import type { SyncAcceptor, SyncConnection, SyncNode } from "./transport"
import type { WorkspaceReplica } from "./workspaceSet"
import { createPeerHistoryObjectReader, liveWorkspaceSetSync, workspaceSet, type LiveWorkspaceSync } from "./workspaceSet"
import { startPersistentNode } from "./persistentNode"
import { userMessage } from "./deviceSyncState"
import { showInviteQr } from "./deviceSyncInviteView"
import type { PairingContext } from "./deviceSyncContext"
import type { JoinDecision } from "./deviceSyncJoinApproval"
import { keeperCommitReceiptVerifier, type KeeperCommitReceiptVerifier } from "./keeperCommitReceipt"
import { createWorkspaceJoinApprovalCache, type JoinApprovalOwnerConnection } from "./workspaceJoinApprovalCache"
import { approveWorkspaceAccess, prepareWorkspaceAccess, readWorkspaceRequest } from "./deviceSyncHostAdmission"
import { meshIngressBudgetProfile } from "../iroh"
import { traceWorkspaceJoinFailure, WorkspaceAdmissionFailure } from "./workspaceAdmissionFailure"
import { createPeerHistoryAuthorizationGuard } from "./peerHistoryAuthorization"
import { readPeerHistoryAwareAcceptStream } from "./peerHistoryTransport"

export { WorkspaceAdmissionFailure } from "./workspaceAdmissionFailure"

type WorkspaceOption = { id: string; title: string }
type KeeperAdmission = { servicePersonId: string; workspaceIds: string[]; followOwner: boolean; serviceGrantFloors?: Record<string, number> }

export type WorkspaceHostContext = PairingContext & {
  workspace: WorkspaceReplica
  startMesh: (node?: SyncNode) => Promise<void>
  setNode: (node: SyncNode | undefined) => void
  getNode: () => SyncNode | undefined
  attachLiveSession: (session: LiveWorkspaceSync, run: number) => void
  detachLiveSession: (session: LiveWorkspaceSync) => void
  waitForJoinDecision: (personId: string, displayName: string, ownerConnection?: boolean) => Promise<JoinDecision | null>
  replaceDirectSession: (personId: string, session: LiveWorkspaceSync) => LiveWorkspaceSync | undefined
  removeDirectSession: (personId: string, session: LiveWorkspaceSync) => void
}

function startWorkspaceHostNode(context: Pick<WorkspaceHostContext, "durableMesh" | "transport">): Promise<SyncNode> {
  return context.durableMesh?.startInstanceNode() ?? startPersistentNode(context.transport)
}

export async function generateWorkspaceInvite(context: WorkspaceHostContext) {
  if (context.state.selectedWorkspaceIds.value.length === 0) return
  try {
    await createWorkspaceHost(context)
  } catch (err) {
    console.error("generateWorkspaceInvite failed", err)
    context.state.step.value = "error"
    context.state.error.value = userMessage(err, "Couldn’t generate invite.")
  }
}

async function createWorkspaceHost(context: WorkspaceHostContext) {
  const profile = await context.getProfile()
  const workspaces = selectedWorkspaces(context)
  const owners = await workspaceOwners(context, workspaces, profile)
  await context.pauseMesh()
  await context.stopNode("Starting workspace host")
  const run = context.nextRun()
  clearHostNotice(context)
  const node = await startWorkspaceHostNode(context)
  if (run !== context.currentRun()) return void node.close("Replaced")
  context.setNode(node)
  await context.durableMesh?.ensureOwnerWorkspaces(workspaces.map(item => item.id), node.endpointId, profile)
  const invite = await createHostInvite(context, node, profile, workspaces)
  if (!context.workspaceStore) throw new Error("Workspace sync is unavailable.")
  const replica = workspaceSet(context.meshWorkspaceStore ?? context.workspaceStore, workspaces)
  context.state.liveWorkspaceIds.value = workspaces.map(item => item.id)
  await startWorkspaceHostController({ context, run, node, profile, invite, owners, workspaces, replica })
}

function selectedWorkspaces(context: WorkspaceHostContext) {
  const selected = context.state.selectedWorkspaceIds.value
  const available = context.availableWorkspaces.filter(item => selected.includes(item.id))
  return available.length > 0 ? available : selected.map(id => ({ id, title: "Workspace" }))
}

async function workspaceOwners(context: WorkspaceHostContext, workspaces: WorkspaceOption[], profile: LocalProfile) {
  const owners = new Map<string, string>()
  for (const workspace of workspaces) {
    const owner = context.workspaceOwner ? await context.workspaceOwner(workspace.id) : profile.identity.personId
    if (owner !== profile.identity.personId) throw new Error(`Only the workspace owner can invite peers to ${workspace.title}`)
    owners.set(workspace.id, owner)
  }
  return owners
}

function clearHostNotice(context: WorkspaceHostContext) {
  context.state.copyNotice.value = ""
  context.state.error.value = ""
}

async function createHostInvite(context: WorkspaceHostContext, node: SyncNode, profile: LocalProfile, workspaces: WorkspaceOption[]) {
  const invite = await issueWorkspaceInvite(context, node, profile, workspaces)
  await showInviteQr(context.state, invitationUrl(context.origin(), invite))
  context.state.step.value = "workspace-host"
  return invite
}

async function issueWorkspaceInvite(context: WorkspaceHostContext, node: SyncNode, profile: LocalProfile, workspaces: WorkspaceOption[], role: "editor" | "visitor" = "visitor") {
  const secret = createPairingSecret()
  const invite = createWorkspaceJoinInvite(node.endpointId, secret, profile, workspaces, { role })
  await defaultInvitationService.saveIssuedInvitation(invite)
  return invite
}

export type HostInput = {
  context: WorkspaceHostContext
  run: number
  node: SyncNode
  profile: LocalProfile
  invite: WorkspaceJoinInvitation
  owners: Map<string, string>
  workspaces: WorkspaceOption[]
  replica: ReturnType<typeof workspaceSet>
  keeperAdmission?: KeeperAdmission
}

export type OwnerConnection = JoinApprovalOwnerConnection
export type HostRuntime = HostInput & {
  acceptor: SyncAcceptor
  peers: Map<string, LiveWorkspaceSync>
  connections: Set<SyncConnection>
  grants: Map<string, { ok: true; grants: WorkspaceGrant[]; ownerConnection?: { controllerPersonId: string } }>
  approvals: ReturnType<typeof createWorkspaceJoinApprovalCache>
  group: LiveWorkspaceSync
  stopped: () => boolean
  disconnect: () => void
  handoff: () => Promise<void>
  fail: (error: unknown) => void
}

async function startWorkspaceHostController(input: HostInput) {
  const acceptor = await input.node.accept()
  const peers = new Map<string, LiveWorkspaceSync>()
  const connections = new Set<SyncConnection>()
  const grants = new Map<string, { ok: true; grants: WorkspaceGrant[] }>()
  const approvals = createWorkspaceJoinApprovalCache()
  let stopped = false
  let everConnected = false
  let handoffStarted = false
  let handoffPromise: Promise<void> | undefined
  let fail!: (error: unknown) => void
  const done = new Promise<void>((_, reject) => { fail = reject })
  const offline = () => { for (const connection of connections) void connection.close() }
  window.addEventListener("offline", offline)
  const handoff = () => handoffPromise ??= handoffWorkspaceHost()
  const disconnect = () => {
    if (input.run !== input.context.currentRun() || stopped || peers.size) return
    input.context.state.directLive.value = false
    if (!everConnected) return
    if (!input.keeperAdmission) input.context.state.step.value = "workspace-reconnecting"
    if (handoffStarted) return
    handoffStarted = true
    void handoffDisconnectedPeer(input)
  }
  const clearApprovals = () => approvals.clear()
  const group = createHostGroup(done, peers, connections, acceptor, () => { stopped = true; clearApprovals() }, offline)
  const runtime = (): HostRuntime => ({ ...input, acceptor, peers, connections, grants, approvals, group, stopped: () => stopped, disconnect, handoff, fail })
  input.context.attachLiveSession(group, input.run)
  input.context.state.directLive.value = false
  void acceptHostPeers(runtime(), () => { everConnected = true }).catch(fail)

  async function handoffWorkspaceHost() {
    handoffStarted = true
    stopped = true
    window.removeEventListener("offline", offline)
    await acceptor.close().catch(() => {})
    input.context.detachLiveSession(group)
    const adoptedNode = input.context.getNode()
    input.context.setNode(undefined)
    await input.context.startMesh(adoptedNode)
    await input.context.durableMesh?.waitUntilListening()
  }
}

function createHostGroup(done: Promise<void>, peers: Map<string, LiveWorkspaceSync>, connections: Set<SyncConnection>, acceptor: SyncAcceptor, stop: () => void, offline: () => void): LiveWorkspaceSync {
  return {
    done,
    async publish() { await Promise.all([...peers.values()].map(session => publishPeer(session))) },
    async close() {
      stop()
      window.removeEventListener("offline", offline)
      await acceptor.close()
      await Promise.all([...connections].map(connection => connection.close()))
    },
  }
}

export async function createKeeperWorkspaceHost(
  context: WorkspaceHostContext,
  workspaces: WorkspaceOption[],
  servicePersonId: string,
  followOwner = false,
  serviceGrantFloors?: Record<string, number>,
) {
  if (!workspaces.length || !servicePersonId) throw new Error("Keeper scopes and service identity are required.")
  const profile = await context.getProfile()
  const owners = await workspaceOwners(context, workspaces, profile)
  await context.pauseMesh()
  await context.stopNode("Starting Keeper invitation host")
  const run = context.nextRun()
  clearHostNotice(context)
  const node = await startWorkspaceHostNode(context)
  if (run !== context.currentRun()) {
    await node.close("Keeper provisioning superseded")
    throw new Error("Keeper provisioning was cancelled.")
  }
  context.setNode(node)
  await context.durableMesh?.ensureOwnerWorkspaces(workspaces.map(item => item.id), node.endpointId, profile)
  const invite = await issueWorkspaceInvite(context, node, profile, workspaces, "editor")
  if (!context.workspaceStore) throw new Error("Workspace sync is unavailable.")
  const replica = workspaceSet(context.meshWorkspaceStore ?? context.workspaceStore, workspaces)
  context.state.liveWorkspaceIds.value = workspaces.map(item => item.id)
  await startWorkspaceHostController({
    context, run, node, profile, invite, owners, workspaces, replica,
    keeperAdmission: { servicePersonId, workspaceIds: workspaces.map(item => item.id), followOwner, serviceGrantFloors },
  })
  return invite
}

async function publishPeer(session: LiveWorkspaceSync) {
  try { await session.publish() } catch (error) {
    await session.close()
    if (!isMeshNetworkFailure(error)) throw error
  }
}

async function handoffDisconnectedPeer(input: HostInput) {
  const adoptedNode = input.context.getNode()
  input.context.setNode(undefined)
  await input.context.stopNode("Invitation peer disconnected")
  if (input.run === input.context.currentRun()) await input.context.startMesh(adoptedNode)
  else await adoptedNode?.close("Invitation superseded").catch(() => {})
}

async function acceptHostPeers(runtime: HostRuntime, connected: () => void) {
  while (!runtime.stopped() && runtime.run === runtime.context.currentRun()) {
    const connection = await runtime.acceptor.accept()
    if (!connection) return
    void receivePeer(runtime, meshNetworkConnection(connection, meshIngressBudgetProfile()), connected).catch(runtime.fail)
  }
}

async function receivePeer(runtime: HostRuntime, connection: SyncConnection, connected: () => void) {
  let transferredToMesh = false
  let session: LiveWorkspaceSync | undefined
  let admitted = false
  let heartbeat: (() => void) | undefined
  let personId = ""
  let verifyKeeperCommit: KeeperCommitReceiptVerifier | undefined
  let remoteDeviceId: string | undefined
  let remoteMeshPeers: unknown
  let stage = "accept-stream"
  const timeout = setTimeout(() => { void connection.close() }, 600_000)
  runtime.connections.add(connection)
  try {
    const stream = await connection.acceptStream()
    stage = "pairing-frame-read"
    const rawRequest = await stream.read()
    stage = "mesh-peer-dispatch"
    if (await receiveMeshPeer(runtime, connection, stream, rawRequest)) {
      transferredToMesh = true
      runtime.connections.delete(connection)
      return
    }
    stage = "pairing-frame-inspect"
    const header = inspectPairingFrame(rawRequest)
    if (header.type !== "workspace-join-request" || header.secret !== runtime.invite.secret) return
    const handshake = new BrowserWorkspaceJoinHost(new WasmWorkspaceJoinHandshake(runtime.invite.secret, "host"))
    const result = await handshake.handle(rawRequest, stream, readPeerHistoryAwareAcceptStream(connection), {
      request: payload => {
        stage = "request-validation"
        const guest = readWorkspaceRequest(runtime, payload)
        personId = guest.personId
        remoteMeshPeers = guest.meshPeers
        return guest
      },
      approve: async guest => {
        stage = "access-approval"
        const approval = await approveWorkspaceAccess(runtime, guest)
        if (approval.ok) remoteDeviceId = approval.value.deviceId
        return approval
      },
      prepare: async result => {
        stage = "response-preparation"
        const payload = await prepareWorkspaceAccess(runtime, result, runtime.keeperAdmission ? async snapshot => {
          verifyKeeperCommit = await keeperCommitReceiptVerifier(runtime.keeperAdmission!.workspaceIds, snapshot)
        } : undefined)
        stage = "acknowledgement"
        return payload
      },
      beforeAckFrame: (frame, stream) => {
        stage = "auxiliary-frame"
        return serveJoinAuxiliaryFrame(runtime, frame, stream, personId, remoteDeviceId, remoteMeshPeers)
      },
      acknowledged: async payload => {
        stage = "acknowledgement"
        if (runtime.keeperAdmission) {
          if (!verifyKeeperCommit) throw new Error("Keeper commit receipt was not negotiated")
          verifyKeeperCommit(payload)
        } else {
          const guard = () => {
            if (runtime.run !== runtime.context.currentRun() || runtime.stopped()) throw new Error("Invitation superseded")
          }
          await runtime.replica.receive(await runtime.replica.resolveProofs(payload, connection, runtime.invite.secret), true,
            remoteDeviceId ? createPeerHistoryObjectReader(connection, guard) : undefined)
        }
      },
    })
    stage = "session-start"
    if (result.kind !== "accepted" || !("value" in result)) return
    admitted = true
    personId = result.value.personId
    clearTimeout(timeout)
    session = await startPeerSession(runtime, connection, personId, remoteDeviceId, remoteMeshPeers)
    heartbeat = startMeshHeartbeat(session, () => { void session?.close() })
    connected()
    await runtime.group.publish()
    await session.done
  } catch (error) {
    traceWorkspaceJoinFailure(error, stage, admitted)
    const recoverablePreparationFailure = !admitted && stage === "response-preparation"
    if (!runtime.stopped() && runtime.run === runtime.context.currentRun() &&
        !isMeshNetworkFailure(error) && !recoverablePreparationFailure) {
      runtime.fail(admitted ? error : new WorkspaceAdmissionFailure(error))
    }
  } finally {
    heartbeat?.()
    clearTimeout(timeout)
    removePeer(runtime, personId, session)
    runtime.connections.delete(connection)
    if (!transferredToMesh) {
      await connection.close()
      runtime.disconnect()
    }
  }
}

async function receiveMeshPeer(runtime: HostRuntime, connection: SyncConnection, stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>, raw: Uint8Array) {
  if (inspectPairingFrame(raw).type !== "mesh-handshake-request" || !runtime.context.durableMesh) return false
  await runtime.context.durableMesh.acceptOnInvitationNode(connection, stream, raw)
  return true
}

async function serveJoinAuxiliaryFrame(runtime: HostRuntime, frame: Uint8Array,
  stream: Awaited<ReturnType<SyncConnection["acceptStream"]>>, personId: string,
  remoteDeviceId: string | undefined, advertisements: unknown): Promise<boolean> {
  const guard = async () => {
    if (!remoteDeviceId || advertisements === undefined || !runtime.context.durableMesh) {
      throw new Error("Verified guest device is required for history transfer")
    }
    await hostPeerHistoryGuard(runtime, personId, remoteDeviceId, advertisements)()
  }
  if (await runtime.replica.servePeerHistoryBaselineRead(frame, stream, remoteDeviceId, guard)) return true
  if (await runtime.replica.servePeerHistoryDocumentRead(frame, stream, remoteDeviceId, guard)) return true
  if (await runtime.replica.servePeerHistoryObjectRead(frame, stream, remoteDeviceId, guard)) return true
  return runtime.replica.serveProofPage(frame, stream, runtime.invite.secret, guard)
}

function hostPeerHistoryGuard(runtime: HostRuntime, personId: string, remoteDeviceId: string, remoteMeshPeers: unknown) {
  return createPeerHistoryAuthorizationGuard({ workspaceIds: runtime.workspaces.map(workspace => workspace.id),
    personId, deviceId: remoteDeviceId, advertisements: remoteMeshPeers,
    isSessionCurrent: () => runtime.run === runtime.context.currentRun() && !runtime.stopped(),
    checkGuestDevices: (workspaces, person, advertisements) => {
      const grants = runtime.grants.get(person)?.grants
      if (!grants) throw new Error("Workspace access authorization is no longer current")
      return runtime.context.durableMesh!.checkGuestDevices(workspaces, person, advertisements, grants)
    },
  })
}

async function startPeerSession(runtime: HostRuntime, connection: SyncConnection, personId: string, remoteDeviceId?: string,
  remoteMeshPeers?: unknown) {
  if (runtime.run !== runtime.context.currentRun() || runtime.stopped()) throw new Error("Invitation superseded")
  if (!remoteDeviceId || remoteMeshPeers === undefined || !runtime.context.durableMesh) throw new Error("Verified guest device is required")
  const handoff = new BrowserWorkspaceJoinHandoffHost(new WasmWorkspaceJoinHandoff(runtime.invite.secret, "host"))
  const ensureCurrent = hostPeerHistoryGuard(runtime, personId, remoteDeviceId, remoteMeshPeers)
  const session = liveWorkspaceSetSync(connection, runtime.invite.secret, runtime.replica, {
    remoteDeviceId,
    ensureCurrent,
    onHandoffRequest: async (stream, requestFrame, acceptConfirmation) => {
      await handoff.run(stream, requestFrame, { ...connection, acceptStream: acceptConfirmation })
      await runtime.handoff()
    },
  })
  const previous = runtime.context.replaceDirectSession(personId, session)
  runtime.peers.set(personId, session)
  await previous?.close()
  runtime.context.state.directLive.value = true
  if (!runtime.keeperAdmission) runtime.context.state.step.value = "synced"
  return session
}

function removePeer(runtime: HostRuntime, personId: string, session: LiveWorkspaceSync | undefined) {
  if (!session || runtime.peers.get(personId) !== session) return
  runtime.peers.delete(personId)
  runtime.context.removeDirectSession(personId, session)
}
