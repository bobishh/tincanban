import { type ScopedInvitation } from "@meta-uber/mesh-pairing"
import { BrowserWorkspaceJoinGuest, BrowserWorkspaceJoinHandoffGuest } from "@meta-uber/mesh-runtime"
import { isMeshNetworkFailure, meshNetworkConnection, meshNetworkIO } from "@meta-uber/mesh-transport"
import type { LocalProfile } from "../domain/identity"
import { fromBase64Url } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { registerWorkspaceInRoot } from "../domain/personalRoot"
import { defaultStorage } from "../storage"
import { WasmWorkspaceJoinHandshake, WasmWorkspaceJoinHandoff } from "../iroh"
import type { DeviceSyncState, WorkspaceJoinPayload } from "./deviceSyncState"
import { meshOwnersMatch, userMessage, validWorkspaceJoinPayload } from "./deviceSyncState"
import type { DurableMesh } from "./durableMesh"
import { offlineRetryDelay } from "./offlineRetry"
import { startPersistentNode } from "./persistentNode"
import type { SyncConnection, SyncNode, SyncTransport } from "./transport"
import { liveWorkspaceSetSync, type LiveWorkspaceSync, type WorkspaceReplica, type WorkspaceSetStore, workspaceSet } from "./workspaceSet"

export type WorkspaceJoinBrowserContext = {
  state: DeviceSyncState
  workspace: WorkspaceReplica
  workspaceStore: WorkspaceSetStore
  meshWorkspaceStore?: WorkspaceSetStore
  durableMesh?: DurableMesh
  transport: SyncTransport
  getProfile: () => Promise<LocalProfile>
  displayName?: () => string
  currentRun: () => number
  waitToReconnect: (milliseconds: number) => Promise<void>
  setNode: (node: SyncNode | undefined) => void
  getNode: () => SyncNode | undefined
  setLiveSession: (session: LiveWorkspaceSync | undefined) => void
  setStopWatching: (stop: (() => void) | undefined) => void
  clearPairingLocation: () => void
}

type WorkspaceJoinInvite = Extract<ScopedInvitation, { kind: "workspace-join" }>

export function isWorkspacePairingLocation(rawUrl: string, prepare: (url: string) => void) {
  const url = new URL(rawUrl)
  if (url.pathname.replace(/\/$/, "") !== "/pair" || !url.hash) return false
  prepare(rawUrl)
  return true
}

type GuestCycle = {
  node?: SyncNode
  connection?: SyncConnection
  session?: LiveWorkspaceSync
  adopted: boolean
  registered?: boolean
}

export async function connectWorkspaceJoin(context: WorkspaceJoinBrowserContext, run: number, invite: WorkspaceJoinInvite) {
  const profile = await context.getProfile()
  if (profile.identity.personId === invite.issuerPersonId) {
    throw new Error("This invite is for another person, but this browser uses the owner's identity. Use a separate identity to join as an editor.")
  }
  const replica = workspaceSet(context.meshWorkspaceStore ?? context.workspaceStore, invite.workspaces.map(item => item.id))
  let attempts = 0
  while (context.currentRun() === run) {
    if (!navigator.onLine) {
      context.state.step.value = "workspace-reconnecting"
      await context.waitToReconnect(offlineRetryDelay(attempts + 1))
      continue
    }
    const cycle = await connectGuestCycle(context, run, invite, profile, replica, attempts)
    if (context.currentRun() !== run) return
    if (cycle.adopted) return
    attempts += 1
    await context.waitToReconnect(offlineRetryDelay(attempts))
  }
}

export function reportWorkspaceJoinFailure(state: DeviceSyncState, currentRun: number, run: number, invite: WorkspaceJoinInvite, error: unknown) {
  if (run !== currentRun) return
  state.directLive.value = false
  state.step.value = "error"
  if (/access revoked/i.test(error instanceof Error ? error.message : String(error))) {
    state.revokedWorkspaceIds.value = [...new Set([...state.revokedWorkspaceIds.value, ...invite.workspaces.map(item => item.id)])]
  }
  console.error("Workspace sync failed", error)
  state.error.value = userMessage(error, "Couldn’t save the received workspaces.")
}

async function connectGuestCycle(context: WorkspaceJoinBrowserContext, run: number, invite: WorkspaceJoinInvite,
  profile: LocalProfile, replica: ReturnType<typeof workspaceSet>, attempts: number): Promise<GuestCycle> {
  const cycle: GuestCycle = { adopted: false }
  const offline = () => {
    if (context.currentRun() !== run) return
    context.state.directLive.value = false
    context.state.step.value = "workspace-reconnecting"
    void cycle.connection?.close()
    if (!cycle.connection) void cycle.node?.close("Network offline").catch(() => {})
  }
  window.addEventListener("offline", offline)
  try {
    cycle.node = await startGuestNode(context, attempts)
    if (context.currentRun() !== run) return cycle
    context.setNode(cycle.node)
    cycle.registered = true
    cycle.connection = meshNetworkConnection(await meshNetworkIO(dialGuest(cycle.node, invite.issuerEndpoint)))
    await installGuestInvitation(context, run, invite, profile, replica, cycle)
    cycle.session = liveWorkspaceSetSync(cycle.connection, invite.secret, replica)
    context.setLiveSession(cycle.session)
    context.state.isEnabled.value = true
    context.state.revokedWorkspaceIds.value = context.state.revokedWorkspaceIds.value.filter(id => !invite.workspaces.some(item => item.id === id))
    context.state.directLive.value = true
    context.setStopWatching(context.workspace.subscribe?.(() => {
      void cycle.session?.publish().catch(() => { void cycle.session?.close() })
    }))
    await cycle.session.publish()
    const handoff = new BrowserWorkspaceJoinHandoffGuest(new WasmWorkspaceJoinHandoff(invite.secret, "guest"))
    const outcome = await handoff.run(cycle.connection, async () => {
      // Transfer ownership before awaiting startup: closing the pairing UI cannot close an adopted mesh node.
      cycle.adopted = Boolean(context.durableMesh)
      if (cycle.adopted) context.setNode(undefined)
      await context.durableMesh?.resumeAll(cycle.node)
      await context.durableMesh?.waitUntilListening()
    }, async () => {
      await context.durableMesh?.pauseAll()
      cycle.adopted = false
    })
    if (outcome.kind === "retry") {
      context.state.step.value = "workspace-reconnecting"
    } else {
      cycle.adopted = true
      if (!outcome.confirmationSent) console.warn("Workspace mesh adopted; host handoff confirmation failed", outcome.error)
      context.state.liveWorkspaceIds.value = invite.workspaces.map(item => item.id)
      context.state.step.value = "workspace-guest-done"
      context.clearPairingLocation()
    }
  } catch (error) {
    if (context.currentRun() !== run) return cycle
    if (!isMeshNetworkFailure(error)) throw error
    context.state.step.value = "workspace-reconnecting"
  } finally {
    window.removeEventListener("offline", offline)
    await cleanupGuestCycle(context, run, cycle)
  }
  return cycle
}

async function cleanupGuestCycle(context: WorkspaceJoinBrowserContext, run: number, cycle: GuestCycle) {
  if (context.currentRun() === run) {
    context.setStopWatching(undefined)
    context.setLiveSession(undefined)
    context.state.directLive.value = false
  }
  await cycle.session?.close()
  await cycle.connection?.close()
  if (!cycle.adopted && (!cycle.registered || context.getNode() === cycle.node))
    await cycle.node?.close("Reconnecting").catch(() => {})
  if (context.getNode() === cycle.node) context.setNode(undefined)
}

async function startGuestNode(context: WorkspaceJoinBrowserContext, attempts: number) {
  if (context.durableMesh) return context.durableMesh.startInstanceNode()
  return attempts === 0 ? startPersistentNode(context.transport) : context.transport.start()
}

function dialGuest(node: SyncNode, endpoint: string) {
  return node.dialRelay ? node.dialRelay(endpoint) : node.dial(endpoint)
}

async function installGuestInvitation(context: WorkspaceJoinBrowserContext, run: number, invite: WorkspaceJoinInvite,
  profile: LocalProfile, replica: ReturnType<typeof workspaceSet>, cycle: GuestCycle) {
  const connection = cycle.connection!
  const stream = await connection.openStream()
  const workspaceIds = invite.workspaces.map(item => item.id)
  const request = new TextEncoder().encode(JSON.stringify({
    invitationId: invite.invitationId,
    personId: profile.identity.personId,
    displayName: context.displayName?.() || profile.identity.displayName,
    meshPeers: await context.durableMesh?.createGuestAdvertisements(workspaceIds, cycle.node!.endpointId, profile),
  }))
  context.state.step.value = "workspace-guest-waiting"
  const guest = new BrowserWorkspaceJoinGuest(new WasmWorkspaceJoinHandshake(invite.secret, "guest"))
  await guest.handle(stream, connection, request, bytes => installReceivedInvitation(context, run, invite, profile, replica, workspaceIds, bytes, connection))
}

async function installReceivedInvitation(context: WorkspaceJoinBrowserContext, run: number, invite: WorkspaceJoinInvite,
  profile: LocalProfile, replica: ReturnType<typeof workspaceSet>, workspaceIds: string[], bytes: Uint8Array, connection: SyncConnection) {
  const received = JSON.parse(new TextDecoder().decode(bytes)) as WorkspaceJoinPayload
  if (context.durableMesh && received.meshWorkspaces === undefined) throw new Error("The other device needs an update. Reload it and generate a new invitation.")
  if (!validWorkspaceJoinPayload(received, workspaceIds, profile.identity.personId)) throw new Error("The other device needs an update. Reload it and generate a new invitation.")
  if (context.currentRun() !== run) throw new Error("Workspace join was cancelled.")
  if (!meshOwnersMatch(received.meshWorkspaces, invite.issuerPersonId)) throw new Error("Invitation owner mismatch")
  const snapshot = await replica.resolveProofs(fromBase64Url(received.snapshot), connection, invite.secret)
  await replica.validate(snapshot)
  await context.durableMesh?.validateInvitation(received.meshWorkspaces, workspaceIds, profile, received.grants)
  for (const grant of received.grants) await defaultProofStore.putGrant(grant.payload.grantId, grant)
  await context.durableMesh?.receiveInvitation(received.meshWorkspaces, workspaceIds, profile, received.grants)
  await replica.receive(snapshot)
  await defaultStorage.updatePersonalRootForIdentity(profile.identity.personId, personalRoot => {
    if (!personalRoot) return null
    personalRoot.workspaces ??= {}
    for (const workspaceId of workspaceIds) registerWorkspaceInRoot(personalRoot, workspaceId, workspaceId, "import")
    return personalRoot
  })
  await context.workspaceStore.activate(invite.workspaces[0]!.id)
  return { value: received, acknowledgement: await replica.snapshot() }
}
