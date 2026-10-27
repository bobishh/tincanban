import { computed, onScopeDispose, ref, watch, type Ref } from "vue"
import type { WorkspaceParticipant } from "../sync/workspaceParticipants"
import { replicationPresence, replicationSummary } from "../sync/replicationHealth"
import type { BlindReplicationController } from "./blindReplication"
import type { WorkspaceRole } from "../domain/permissions"
import { describeUserAgent } from "../ui/deviceInfo"
import type { useDeviceSync } from "../sync/useDeviceSync"
import type { useWorkspaceChat } from "../chat/useWorkspaceChat"

type MeshContext = {
  activeWorkspace: { id: string }
  chat: ReturnType<typeof useWorkspaceChat>
  currentRole: Ref<WorkspaceRole>
  currentWorkspaceOwnerId: Ref<string>
  blindReplication: BlindReplicationController
  sync: ReturnType<typeof useDeviceSync>
}

export function useAppMesh(context: MeshContext) {
  const { activeWorkspace, chat, currentRole, currentWorkspaceOwnerId, sync, blindReplication } = context
  const activeMeshPeers = computed(() => sync.meshPeers.value.filter(peer =>
    peer.workspaceId === activeWorkspace.id && peer.deviceId !== sync.localDeviceId.value && !peer.revokedAt,
  ))
  const liveChannel = computed(() => sync.isWorkspaceLive(activeWorkspace.id) || activeMeshPeers.value.some(peer => peer.online))
  const devicePresence = ref<"connected" | "reconnecting" | "offline" | "empty">("empty")
  let offlineTimer: ReturnType<typeof setTimeout> | undefined
  watch([() => activeWorkspace.id, liveChannel, () => sync.isEnabled.value, () => sync.networkOnline.value,
    () => sync.isWorkspaceAccessRevoked(activeWorkspace.id), () => activeMeshPeers.value.length],
  ([workspaceId, connected, enabled, networkOnline, revoked, peerCount]) => {
    clearTimeout(offlineTimer)
    if (networkOnline !== false && connected) {
      devicePresence.value = "connected"
    } else if (revoked || networkOnline === false || !enabled) {
      devicePresence.value = peerCount ? "offline" : "empty"
    } else if (peerCount) {
      devicePresence.value = "reconnecting"
      offlineTimer = setTimeout(() => {
        if (activeWorkspace.id === workspaceId && !liveChannel.value) devicePresence.value = "offline"
      }, 4_000)
    } else {
      devicePresence.value = "empty"
    }
  }, { immediate: true })
  onScopeDispose(() => clearTimeout(offlineTimer))
  const devicePresenceLabel = computed(() => ({
    connected: "Mesh connected",
    reconnecting: "Mesh reconnecting",
    offline: "Mesh offline",
    empty: "Mesh empty",
  }[devicePresence.value]))
  const meshPresence = computed(() => replicationPresence(devicePresence.value, blindReplication.configs.value,
    blindReplication.statuses.value, activeWorkspace.id, blindReplication.now.value))
  const meshPresenceLabel = computed(() => {
    const rusty = replicationSummary(blindReplication.configs.value, blindReplication.statuses.value, activeWorkspace.id, blindReplication.now.value)
    if (!rusty) return devicePresenceLabel.value
    const devices = { connected: "Devices connected", reconnecting: "Devices reconnecting", offline: "Devices offline", empty: "No live devices" }[devicePresence.value]
    return `${devices} · ${rusty}`
  })
  const activeMeshRetryAt = computed(() => sync.meshRetryAt.value[activeWorkspace.id])
  const onlineWorkspaceDevices = computed(() => {
    const ids = new Set(sync.meshPeers.value.filter(peer => peer.workspaceId === activeWorkspace.id && !peer.revokedAt && peer.online)
      .map(peer => peer.deviceId))
    if (sync.localDeviceId.value) ids.add(sync.localDeviceId.value)
    return Math.max(1, ids.size)
  })
  const participants = ref<WorkspaceParticipant[]>([])
  let participantWorkspace = ""
  let participantRead = 0
  async function refreshParticipants() {
    const workspaceId = activeWorkspace.id
    const read = ++participantRead
    if (participantWorkspace !== workspaceId) { participants.value = []; participantWorkspace = workspaceId }
    if (!sync.isOpen.value) return
    try {
      const { readWorkspaceParticipants } = await import("../sync/workspaceParticipants")
      const people = await readWorkspaceParticipants(workspaceId)
      if (read === participantRead && activeWorkspace.id === workspaceId) participants.value = people
    } catch { /* Presence cannot confer membership when durable access is unavailable. */ }
  }
  watch([() => activeWorkspace.id, sync.isOpen,
    () => sync.meshPeers.value.filter(peer => peer.workspaceId === activeWorkspace.id)
      .map(peer => `${peer.personId}:${peer.role}:${peer.revokedAt ?? ""}`).sort().join("|"),
    () => chat.members.value.map(person => person.personId).sort().join("|"), currentWorkspaceOwnerId, currentRole], () => { void refreshParticipants() }, { immediate: true })
  onScopeDispose(() => { participantRead++ })
  const revokingPeer = ref("")
  const peerAccessError = ref("")
  const meshMembers = computed(() => {
    const peers = sync.meshPeers.value.filter(peer => peer.workspaceId === activeWorkspace.id && !peer.revokedAt)
    const selfId = chat.personId.value
    const personIds = new Set([...peers.map(peer => peer.personId), ...participants.value.map(person => person.personId)])
    if (selfId) personIds.add(selfId)
    return [...personIds].map(personId => createMeshMember(personId, peers, selfId, sync, chat, currentWorkspaceOwnerId.value, currentRole.value,
      devicePresence.value === "reconnecting", participants.value.find(person => person.personId === personId)?.role ?? "visitor"))
      .sort((a, b) => Number(b.self) - Number(a.self) || Number(b.role === "owner") - Number(a.role === "owner") || a.name.localeCompare(b.name))
  })
  const activeSuccession = computed(() => sync.meshSuccession.value.find(item => item.workspaceId === activeWorkspace.id))
  const successionVotesForSelf = computed(() => activeSuccession.value?.votes.filter(vote => vote.candidatePersonId === chat.personId.value).length ?? 0)
  const canClaimSuccession = computed(() => currentRole.value === "editor" && Boolean(activeSuccession.value) && !activeSuccession.value!.conflicted &&
    (activeSuccession.value!.successorPersonId === chat.personId.value || (!activeSuccession.value!.successorPersonId && successionVotesForSelf.value >= activeSuccession.value!.quorum)))
  const transferringOwnership = ref("")
  const leavingMesh = ref(false)

  async function transferWorkspaceOwnership(personId: string) {
    if (transferringOwnership.value) return
    transferringOwnership.value = personId
    peerAccessError.value = ""
    try { await sync.transferOwnership(personId) }
    catch (error) { peerAccessError.value = error instanceof Error ? error.message : "Could not transfer ownership" }
    finally { transferringOwnership.value = "" }
  }
  const meshAction = (action: () => Promise<void>, message: string) => async () => {
    peerAccessError.value = ""
    try { await action() }
    catch (error) { peerAccessError.value = error instanceof Error ? error.message : message }
  }
  const promoteWorkspacePeer = (personId: string) => meshAction(() => sync.promotePeer(personId), "Could not promote member")()
  async function leaveWorkspaceMesh() {
    if (leavingMesh.value) return
    leavingMesh.value = true
    peerAccessError.value = ""
    try { await sync.leaveMesh() }
    catch (error) { peerAccessError.value = error instanceof Error ? error.message : "Could not leave mesh" }
    finally { leavingMesh.value = false }
  }
  const claimWorkspaceSuccession = meshAction(() => sync.claimSuccession(), "Could not claim ownership")
  const setWorkspaceSuccessor = (personId: string | null) => meshAction(() => sync.setSuccessor(personId), "Could not set successor")()
  const voteForWorkspaceSuccessor = (personId: string) => meshAction(() => sync.voteForSuccessor(personId), "Could not record vote")()
  async function revokeWorkspacePeer(personId: string) {
    if (revokingPeer.value) return
    revokingPeer.value = personId
    peerAccessError.value = ""
    try { await sync.revokePeer(personId) }
    catch (error) { peerAccessError.value = error instanceof Error ? error.message : "Could not revoke access" }
    finally { revokingPeer.value = "" }
  }
  return { promoteWorkspacePeer, devicePresence, meshPresence, meshPresenceLabel, activeMeshRetryAt, onlineWorkspaceDevices, revokingPeer, peerAccessError, meshMembers, activeSuccession, canClaimSuccession, transferringOwnership, leavingMesh, transferWorkspaceOwnership, leaveWorkspaceMesh, setWorkspaceSuccessor, voteForWorkspaceSuccessor, claimWorkspaceSuccession, revokeWorkspacePeer }
}

function createMeshMember(personId: string, peers: ReturnType<typeof useDeviceSync>["meshPeers"]["value"], selfId: string, sync: ReturnType<typeof useDeviceSync>, chat: ReturnType<typeof useWorkspaceChat>, ownerId: string, currentRole: WorkspaceRole, reconnecting: boolean, retainedRole: "owner" | "editor" | "visitor") {
  const devices = peers.filter(peer => peer.personId === personId)
  const self = personId === selfId
  const pendingRemote = reconnecting && !self
  const localUserAgent = sync.localUserAgent.value || undefined
  const deviceList = devices.map(peer => ({
    deviceId: peer.deviceId, name: peer.deviceName || `Device ${peer.deviceId.slice(0, 6)}`,
    online: peer.online || (self && peer.deviceId === sync.localDeviceId.value),
    reconnecting: awaitingRemote(pendingRemote, peer.online), lastSeen: peer.lastSeen,
    userAgent: peer.userAgent || (self && peer.deviceId === sync.localDeviceId.value ? localUserAgent : undefined),
    description: describeUserAgent(peer.userAgent || (self && peer.deviceId === sync.localDeviceId.value ? localUserAgent : undefined)), tabs: peer.instances ?? 1,
  }))
  if (self && sync.localDeviceId.value && !deviceList.some(device => device.deviceId === sync.localDeviceId.value)) deviceList.push({ deviceId: sync.localDeviceId.value, name: "This device", online: true, reconnecting: false, lastSeen: new Date().toISOString(), userAgent: localUserAgent, description: describeUserAgent(localUserAgent), tabs: 1 })
  const peerRole = devices[0]?.role ?? retainedRole
  return { personId, name: self ? chat.displayName.value || "You" : chat.members.value.find(member => member.personId === personId)?.name ?? `Participant · ${personId.slice(0, 6)}`, role: self ? currentRole : personId === ownerId ? "owner" as const : peerRole === "owner" ? "editor" as const : peerRole, online: deviceList.some(device => device.online), reconnecting: awaitingRemote(pendingRemote, deviceList.some(device => device.online)), onlineDevices: deviceList.filter(device => device.online).length, devices: deviceList.length, deviceList, self }
}

function awaitingRemote(pendingRemote: boolean, online: boolean): boolean { return pendingRemote && !online }
