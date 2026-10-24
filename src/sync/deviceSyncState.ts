import { computed, ref } from "vue"
import type { ScopedInvitation } from "@meta-uber/mesh-pairing"
import { isMeshDialNetworkFailure } from "@meta-uber/mesh-runtime"
import type { MeshPeerView, MeshSuccessionView } from "./durableMesh"
import type { WorkspaceGrant } from "../domain/model"

const MAX_SYNC_ERROR_LENGTH = 512

export type SyncStep =
  | "idle" | "members" | "chooser" | "workspace-select" | "enroll-host"
  | "enroll-host-preparing" | "enroll-host-pending" | "enroll-host-done" | "enroll-syncing"
  | "workspace-host-select" | "workspace-host" | "enroll-guest"
  | "enroll-guest-waiting" | "enroll-guest-done" | "workspace-guest"
  | "workspace-reconnect-confirm" | "workspace-merge-confirm" | "workspace-reconnecting" | "workspace-guest-waiting"
  | "workspace-guest-done" | "synced" | "error"

export type SyncPhase = "idle" | "preparing" | "ready" | "join-ready" | "joining" | "synced" | "error"

export type PendingJoin = {
  id: string
  name: string
  personId: string
  role: "visitor" | "editor"
  ownerConnectionRequested?: boolean
  followOwner?: boolean
}

export function createDeviceSyncState() {
  const isOpen = ref(false)
  const isEnabled = ref(false)
  const directLive = ref(false)
  const liveWorkspaceIds = ref<string[]>([])
  const step = ref<SyncStep>("idle")
  const qrCode = ref("")
  const inviteUrl = ref("")
  const copyNotice = ref("")
  const error = ref("")
  const authCode = ref("")
  const pendingJoins = ref<PendingJoin[]>([])
  const selectedWorkspaceId = ref("")
  const selectedWorkspaceIds = ref<string[]>([])
  const invitationWorkspaceTitle = ref("")
  const invitationWorkspaces = ref<{ id: string; title: string }[]>([])
  const parsedInvite = ref<ScopedInvitation | null>(null)
  const meshPeers = ref<MeshPeerView[]>([])
  const meshDiagnostic = ref("")
  const meshRetryAt = ref<Record<string, number>>({})
  const networkOnline = ref(typeof navigator === "undefined" ? true : navigator.onLine)
  const localDeviceId = ref("")
  const canRenewDevice = ref(false)
  const localUserAgent = ref("")
  const meshLiveWorkspaceIds = ref<string[]>([])
  const revokedWorkspaceIds = ref<string[]>([])
  const ownershipRevision = ref(0)
  const meshSuccession = ref<MeshSuccessionView[]>([])
  const enrollmentConflict = ref<{ currentPersonId: string; currentName: string; targetPersonId: string } | null>(null)
  const replacementPersonId = ref<string | undefined>(undefined)
  const enrollmentDeviceName = ref("")
  const enrollmentSameIdentity = ref(false)
  const isLive = computed(() => directLive.value || meshLiveWorkspaceIds.value.length > 0)
  const phase = computed<SyncPhase>(() => step.value === "error" ? "error" : step.value === "synced" ? "synced" : "idle")
  const title = computed(() => {
    if (step.value === "error") return "Couldn’t sync"
    if (["enroll-guest", "enroll-guest-waiting", "enroll-guest-done"].includes(step.value)) return "Add your device"
    if (step.value === "workspace-reconnect-confirm") return "Reconnect device"
    if (step.value === "workspace-merge-confirm") return "Merge local copy?"
    if (["workspace-guest", "workspace-guest-waiting", "workspace-guest-done"].includes(step.value)) return "Join workspace"
    return step.value === "synced" ? "Live sync on" : "Device sync"
  })
  return {
    isOpen, isEnabled, directLive, liveWorkspaceIds, step, qrCode, inviteUrl, copyNotice, error, authCode,
    pendingJoins, selectedWorkspaceId, selectedWorkspaceIds, invitationWorkspaceTitle,
    invitationWorkspaces, parsedInvite, meshPeers, meshDiagnostic, meshRetryAt, networkOnline,
    localDeviceId, canRenewDevice, localUserAgent, meshLiveWorkspaceIds, revokedWorkspaceIds, ownershipRevision,
    meshSuccession, enrollmentDeviceName, enrollmentSameIdentity, enrollmentConflict, replacementPersonId, isLive, phase, title,
  }
}

export type DeviceSyncState = ReturnType<typeof createDeviceSyncState>

export function formatSyncError(err: unknown, fallback: string) {
  const message = err instanceof Error ? err.message : String(err)
  return (message || fallback).slice(0, MAX_SYNC_ERROR_LENGTH)
}

export function userMessage(err: unknown, fallback: string) {
  const message = formatSyncError(err, fallback)
  if (/break-glass authority|legacy workspace authority/i.test(message)) return `This board has unsupported ownership. Invite only an independent imported copy of the board. Details: ${message}`
  if (/Workspace was archived in another tab/i.test(message)) return `This board was archived on this device. Rejoining cannot restore that local copy yet. Use a new board or a fresh browser profile. Details: ${message}`
  if (message === "Invalid pairing link" || message === "This pairing link is invalid.") return "This pairing link is invalid."
  if (/This invitation has expired/i.test(message)) return "This invitation has expired."
  if (/older version of tincanban/i.test(message)) return "This sync link was created by an older version of tincanban. Please create a new invitation."
  if (/Pairing cancelled/i.test(message)) return "Pairing was cancelled on the other device. Generate a new QR and try again."
  if (/out of date document|outdated document/i.test(message)) return "Couldn’t merge workspace changes. Keep this tab open and try pairing again."
  if (isMeshDialNetworkFailure(err)) return "Couldn’t reach the other device. Check both connections and try again."
  return message || fallback
}

export type WorkspaceJoinGrant = WorkspaceGrant & { payload?: { workspaceId?: unknown; personId?: unknown } }
export type WorkspaceJoinPayload = { error?: unknown; snapshot?: unknown; grants?: unknown; meshWorkspaces?: unknown }

export function validWorkspaceJoinPayload(payload: WorkspaceJoinPayload, workspaceIds: string[], personId: string):
  payload is WorkspaceJoinPayload & { snapshot: string; grants: Array<WorkspaceJoinGrant & { payload: { workspaceId: string; personId: string } }> } {
  if (typeof payload.snapshot !== "string" || !Array.isArray(payload.grants) || payload.grants.length !== workspaceIds.length) return false
  const grants = payload.grants as WorkspaceJoinGrant[]
  return new Set(grants.map(grant => grant.payload?.workspaceId)).size === workspaceIds.length && grants.every(grant =>
    grant.payload?.personId === personId && typeof grant.payload.workspaceId === "string" && workspaceIds.includes(grant.payload.workspaceId))
}

export function meshOwnersMatch(meshWorkspaces: unknown, ownerPersonId: string): boolean {
  return !Array.isArray(meshWorkspaces) || !meshWorkspaces.some(
    item => !hasMatchingOwner(item, ownerPersonId),
  )
}

function hasMatchingOwner(value: unknown, ownerPersonId: string): boolean {
  if (!value || typeof value !== "object") return false
  return "ownerPersonId" in value && value.ownerPersonId === ownerPersonId
}
