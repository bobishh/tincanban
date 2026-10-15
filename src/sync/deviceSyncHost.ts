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
import { toBase64Url } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
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
import { nextKeeperGrantEpoch } from "./keeperGrantEpoch"
import { WorkspaceAdmissionFailure } from "./workspaceAdmissionFailure"
import { createPeerHistoryAuthorizationGuard } from "./peerHistoryAuthorization"

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

type HostInput = {
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

type WorkspaceGuest = { personId: string; displayName?: unknown; meshPeers?: unknown; followOwner?: unknown }
type OwnerConnection = { controllerPersonId: string }
type HostRuntime = HostInput & {
  acceptor: SyncAcceptor
  peers: Map<string, LiveWorkspaceSync>
  connections: Set<SyncConnection>
  grants: Map<string, { ok: true; grants: WorkspaceGrant[]; ownerConnection?: { controllerPersonId: string } }>
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
  const group = createHostGroup(done, peers, connections, acceptor, () => { stopped = true }, offline)
  const runtime = (): HostRuntime => ({ ...input, acceptor, peers, connections, grants, group, stopped: () => stopped, disconnect, handoff, fail })
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
  await context.stopNode("Starting Lighthouse invitation host")
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
    void receivePeer(runtime, meshNetworkConnection(connection), connected).catch(runtime.fail)
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
  const timeout = setTimeout(() => { void connection.close() }, 600_000)
  runtime.connections.add(connection)
  try {
    const stream = await connection.acceptStream()
    const rawRequest = await stream.read()
    if (await receiveMeshPeer(runtime, connection, stream, rawRequest)) {
      transferredToMesh = true
      runtime.connections.delete(connection)
      return
    }
    const header = inspectPairingFrame(rawRequest)
    if (header.type !== "workspace-join-request" || header.secret !== runtime.invite.secret) return
    const handshake = new BrowserWorkspaceJoinHost(new WasmWorkspaceJoinHandshake(runtime.invite.secret, "host"))
    const result = await handshake.handle(rawRequest, stream, connection, {
      request: payload => {
        const guest = readWorkspaceRequest(runtime, payload)
        personId = guest.personId
        remoteMeshPeers = guest.meshPeers
        return guest
      },
      approve: async guest => {
        const approval = await approveWorkspaceAccess(runtime, guest)
        if (approval.ok) remoteDeviceId = approval.value.deviceId
        return approval
      },
      prepare: result => prepareWorkspaceAccess(runtime, result, runtime.keeperAdmission ? async snapshot => {
        verifyKeeperCommit = await keeperCommitReceiptVerifier(runtime.keeperAdmission!.workspaceIds, snapshot)
      } : undefined),
      beforeAckFrame: (frame, stream) => serveJoinAuxiliaryFrame(runtime, frame, stream,
        personId, remoteDeviceId, remoteMeshPeers),
      acknowledged: async payload => {
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
    if (!runtime.stopped() && runtime.run === runtime.context.currentRun() && !isMeshNetworkFailure(error)) {
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

function readWorkspaceRequest(runtime: HostRuntime, payload: Uint8Array) {
  const guest = JSON.parse(new TextDecoder().decode(payload))
  if (typeof guest.personId !== "string" || !guest.personId || guest.invitationId !== runtime.invite.invitationId) throw new Error("Invalid workspace join request.")
  if (runtime.keeperAdmission && (guest.followOwner === true) !== runtime.keeperAdmission.followOwner) {
    throw new Error("Keeper future-board policy does not match the approved pairing.")
  }
  return guest as { personId: string; displayName?: unknown; meshPeers?: unknown; followOwner?: unknown }
}

async function approveWorkspaceAccess(runtime: HostRuntime, guest: WorkspaceGuest) {
  if (guest.personId === runtime.profile.identity.personId) {
    return { ok: false as const, error: "This invite is for another person, but this browser uses the owner's identity. Use a separate identity to join as an editor." }
  }
  let deviceId: string | undefined
  if (!runtime.context.durableMesh) return { ok: false as const, error: "Couldn’t verify guest device." }
  try { deviceId = await runtime.context.durableMesh.checkGuestDevices(runtime.workspaces.map(item => item.id), guest.personId, guest.meshPeers) }
  catch (error) { return { ok: false as const, error: userMessage(error, "Couldn’t verify guest device.") } }
  if (!deviceId) return { ok: false as const, error: "Couldn’t verify guest device." }
  const existing = runtime.grants.get(guest.personId)
  if (existing) return { ok: true as const, value: { personId: guest.personId, deviceId, grants: existing.grants,
    ownerConnection: existing.ownerConnection } }
  if (Date.parse(runtime.invite.expiresAt) <= Date.now()) {
    return { ok: false as const, error: "This invitation has expired." }
  }
  if (runtime.keeperAdmission && !matchesKeeperAdmission(runtime, guest.personId)) {
    return { ok: false as const, error: "Keeper join does not match the approved identity and scope set." }
  }
  const decision = await decideWorkspaceJoin(runtime, guest)
  if (!decision) {
    return { ok: false as const, error: "The owner declined this request." }
  }
  const ownerConnection = decision.followOwner
    ? { controllerPersonId: runtime.profile.identity.personId } satisfies OwnerConnection : undefined
  const grants = await issueWorkspaceGrants(runtime, guest.personId, decision.role)
  return acceptApprovedGuest(runtime, guest, grants, decision.role, ownerConnection, deviceId)
}

async function decideWorkspaceJoin(runtime: HostRuntime, guest: WorkspaceGuest): Promise<JoinDecision | null> {
  if (runtime.keeperAdmission) {
    return { role: "editor", followOwner: runtime.keeperAdmission.followOwner }
  }
  const name = typeof guest.displayName === "string"
    ? guest.displayName.slice(0, 80)
    : `Participant ${guest.personId.slice(0, 6)}`
  return runtime.context.waitForJoinDecision(guest.personId, name, guest.followOwner === true)
}

async function issueWorkspaceGrants(runtime: HostRuntime, personId: string, role: JoinDecision["role"]) {
  const accessEpochs = new Map(await Promise.all(runtime.workspaces.map(async item => [
    item.id,
    nextKeeperGrantEpoch(await runtime.context.durableMesh?.nextAccessEpoch(item.id) ?? 1,
      runtime.keeperAdmission?.serviceGrantFloors?.[item.id] ?? 0),
  ] as const)))
  const result = await defaultInvitationService.approveWorkspaceJoinSet(
    runtime.invite.invitationId,
    personId,
    runtime.workspaces.map(item => item.id),
    runtime.profile,
    runtime.owners,
    role,
    accessEpochs,
  )
  if (!result.ok) throw new Error(result.error)
  for (const grant of result.grants) {
    await defaultProofStore.putGrant(grant.payload.grantId, grant)
  }
  return result.grants
}

async function acceptApprovedGuest(runtime: HostRuntime, guest: { personId: string; meshPeers?: unknown },
  grants: WorkspaceGrant[], role: JoinDecision["role"], ownerConnection?: OwnerConnection, deviceId?: string) {
  try { await runtime.context.durableMesh?.acceptGuest(runtime.workspaces.map(item => item.id), guest.meshPeers, grants) }
  catch (error) {
    if (error instanceof Error && /Device access revoked/i.test(error.message)) return { ok: false as const, error: error.message }
    throw error
  }
  if (ownerConnection) {
    await runtime.context.durableMesh?.connectOwnerKeeper(guest.personId, role)
  }
  runtime.grants.set(guest.personId, { ok: true, grants, ownerConnection })
  return { ok: true as const, value: { personId: guest.personId, deviceId, grants, ownerConnection } }
}

function matchesKeeperAdmission(runtime: HostRuntime, personId: string) {
  const admission = runtime.keeperAdmission
  if (!admission || personId !== admission.servicePersonId) return false
  const actualScopes = runtime.workspaces.map(workspace => workspace.id).sort()
  const approvedScopes = [...admission.workspaceIds].sort()
  return actualScopes.length === approvedScopes.length
    && actualScopes.every((workspaceId, index) => workspaceId === approvedScopes[index])
}

async function prepareWorkspaceAccess(runtime: HostRuntime, approval: {
  personId: string; grants: WorkspaceGrant[]; ownerConnection?: { controllerPersonId: string }
}, keeperSnapshot?: (snapshot: Uint8Array) => Promise<void>) {
  const injectedFailure = (window as Window & { __TINCANBAN_INJECT_SYNC_SNAPSHOT_FAILURE__?: string }).__TINCANBAN_INJECT_SYNC_SNAPSHOT_FAILURE__
  if (injectedFailure) throw new Error(injectedFailure)
  const snapshot = await runtime.replica.snapshot()
  await keeperSnapshot?.(snapshot)
  return new TextEncoder().encode(JSON.stringify({ grants: approval.grants,
    ownerConnection: approval.ownerConnection,
    snapshot: toBase64Url(snapshot),
    meshWorkspaces: await runtime.context.durableMesh?.invitationPayload(runtime.workspaces.map(item => item.id)),
  }))
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
