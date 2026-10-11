<script setup lang="ts">
import ParticipantAvatar from "./ParticipantAvatar.vue"
import RustyPanel from "./RustyPanel.vue"
import OwnershipRecoveryPanel from "./OwnershipRecoveryPanel.vue"
import type { BlindReplicationController } from "../app/blindReplication"
import RustyMark from "./RustyMark.vue"
import { keeperDisplayName, isKeeper, type MeshMemberView } from "../ui/deviceInfo"
import EnrollmentRequest from "./EnrollmentRequest.vue"
import DeviceRemovalControl from "./DeviceRemovalControl.vue"
import ModalLayer from "./ModalLayer.vue"
import WorkspaceFileActions from "./WorkspaceFileActions.vue"
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from "vue"
import type { SyncStep, SuccessionView } from "../app/syncTypes"


const props = defineProps<{
  initialTab?: "Participants" | "Rusty" | "Backups"
  memberAvatars?: Record<string, string>
  revokingPersonId?: string
  blindReplication?: BlindReplicationController
  pendingJoins?: { id: string; name: string; personId: string; role: "visitor" | "editor"; ownerConnectionRequested?: boolean; followOwner?: boolean }[]
  step: SyncStep
  title: string
  qrCode: string
  inviteUrl: string
  copyNotice: string
  error: string
  canReconnectDevice?: boolean
  enrollmentDeviceName?: string
  enrollmentConflict?: { currentPersonId: string; currentName: string; targetPersonId: string } | null
  authCode?: string
  invitationWorkspaceTitle?: string
  invitationWorkspaces?: { id: string; title: string }[]
  availableWorkspaces?: { id: string; title: string }[]
  selectedWorkspaceIds?: string[]
  selectedWorkspaceId?: string
  meshMembers?: MeshMemberView[]
  activeWorkspaceId?: string
  localDeviceId?: string
  removableDeviceWorkspaces?: (personId: string, deviceId: string) => Promise<{ id: string; title: string }[]>
  removeDevice?: (personId: string, deviceId: string, workspaceIds: string[]) => Promise<void>
  hasMesh?: boolean
  currentPersonId?: string
  currentRole?: "owner" | "editor" | "visitor"
  succession?: SuccessionView
  canClaimSuccession?: boolean
  canManageMesh?: boolean
  transferringOwnership?: string
  leavingMesh?: boolean
  meshActionError?: string
  workspaceConnected?: boolean
  workspaceReconnecting?: boolean
  meshDiagnostic?: string
  retryAt?: number
  networkOnline?: boolean
  live?: boolean
}>()

const emit = defineEmits<{
  (e: "decideJoin", id: string, approve: boolean): void
  (e: "dismiss"): void
  (e: "selectSyncAll"): void
  (e: "selectSyncWorkspace"): void
  (e: "update:selectedWorkspaceIds", val: string[]): void
  (e: "update:selectedWorkspaceId", val: string): void
  (e: "generateWorkspaceInvite"): void
  (e: "transferOwnership", personId: string): void
  (e: "leaveMesh"): void
  (e: "promotePeer", personId: string): void
  (e: "revokePerson", personId: string): void
  (e: "setSuccessor", personId: string | null): void
  (e: "voteSuccessor", personId: string): void
  (e: "claimSuccession"): void
  (e: "copy", url?: string): void
  (e: "requestEnrollment", replaceIdentity: boolean): void
  (e: "approveDevice"): void
  (e: "declineDevice"): void
  (e: "acceptAndJoin"): void
  (e: "reconnectDevice"): void
  (e: "start"): void
  (e: "stop"): void
  (e: "export"): void
  (e: "import"): void
}>()

const selectedIds = computed(() => {
  if (props.selectedWorkspaceIds && props.selectedWorkspaceIds.length > 0) {
    return props.selectedWorkspaceIds
  }
  if (props.selectedWorkspaceId) {
    return [props.selectedWorkspaceId]
  }
  return []
})

const hasSelection = computed(() => selectedIds.value.length > 0)
const invitationChoices = computed(() => (props.availableWorkspaces ?? []).map(workspace => {
  const duplicate = props.availableWorkspaces!.filter(other => other.title === workspace.title).length > 1
  const detail = duplicate ? `${workspace.id}${workspace.id === props.activeWorkspaceId ? " · Current board" : ""}` : ""
  return { ...workspace, detail, label: detail ? `${workspace.title} (${detail})` : workspace.title }
}))
const isEnrollmentHost = computed(
  () => props.step === "enroll-host" || props.step === "enroll-host-pending",
)
const tabs = ["Participants", "Rusty", "Backups", "Advanced"] as const
const activeTab = ref<typeof tabs[number]>(props.initialTab ?? "Participants")
const tabId = useId()
function navigateTabs(event: KeyboardEvent) {
  const index = tabs.indexOf(activeTab.value)
  const target = event.key === "ArrowRight" ? (index + 1) % tabs.length
    : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
    : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1
  if (target < 0 || props.leavingMesh) return
  event.preventDefault()
  activeTab.value = tabs[target]
  ;(event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-tab="${tabs[target]}"]`)?.focus()
}
const selectedMemberId = ref("")
const confirmingRemoval = ref("")
watch(selectedMemberId, () => { confirmingRemoval.value = "" })
const rejectedSource = computed(() => {
  const diagnostic = props.meshDiagnostic ?? ""
  const source = diagnostic.match(/^Workspace .+ from ([A-Za-z0-9_-]{8,})\s*:/)?.[1]
  if (!source || !/Unsigned workspace change rejected/i.test(diagnostic)) return null
  const member = (props.meshMembers ?? []).find(candidate =>
    candidate.deviceList.some(device => device.deviceId.startsWith(source)),
  )
  const device = member?.deviceList.find(candidate => candidate.deviceId.startsWith(source))
  return { diagnostic, source, member, device }
})
const visiblePendingJoins = computed(() => props.pendingJoins ?? [])
const confirmingLeave = ref(false)
const confirmingReconnect = ref(false)
const reconnectCancelled = ref(false)
watch(() => props.step, () => { reconnectCancelled.value = false; activeTab.value = props.initialTab ?? "Participants" })
const selectedMember = computed(() => props.meshMembers?.find(member => member.personId === selectedMemberId.value))
const peopleMembers = computed(() => (props.meshMembers ?? []).filter(member => !member.deviceList.some(device => isKeeper(device.userAgent))))
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 500) })
onBeforeUnmount(() => clearInterval(clock))
const retrySeconds = computed(() => Math.max(1, Math.ceil(((props.retryAt ?? now.value) - now.value) / 1_000)))
const connectionSummary = computed(() => {
  if (props.workspaceConnected) return "Channel open on this device."
  if (props.networkOnline === false) return "Waiting for internet. Changes stay saved on this device."
  if (props.workspaceReconnecting) return "Checking live channel. Changes stay saved on this device."
  if (props.retryAt) return `No live channel. Retrying in ${retrySeconds.value}s.`
  return "No live channel. Reconnecting automatically."
})

function isWorkspaceSelected(id: string) {
  return selectedIds.value.includes(id)
}

function toggleWorkspace(id: string) {
  const current = [...selectedIds.value]
  const idx = current.indexOf(id)
  if (idx >= 0) {
    current.splice(idx, 1)
  } else {
    current.push(id)
  }
  emit("update:selectedWorkspaceIds", current)
  if (current.length > 0) {
    emit("update:selectedWorkspaceId", current[0])
  } else {
    emit("update:selectedWorkspaceId", "")
  }
}

function reviewRejectedSource() {
  if (!rejectedSource.value?.member) return
  selectedMemberId.value = rejectedSource.value.member.personId
}

const guestWorkspaces = computed(() => {
  if (props.invitationWorkspaces && props.invitationWorkspaces.length > 0) {
    return props.invitationWorkspaces
  }
  if (props.invitationWorkspaceTitle) {
    return [{ id: "ws_default", title: props.invitationWorkspaceTitle }]
  }
  return [{ id: "ws_default", title: "Workspace" }]
})

function selectPairingLink(event: FocusEvent | MouseEvent) {
  ;(event.target as HTMLTextAreaElement).select()
}

function deviceConnectionLabel(device: { deviceId: string; online: boolean; reconnecting: boolean }) { return device.deviceId === props.localDeviceId ? "Open in this tab" : device.online ? "Connected to this tab" : device.reconnecting ? "Checking connection" : "No connection" }
</script>

<template>
  <ModalLayer class="overlay" :busy="leavingMesh" @close="emit('dismiss')">
    <section class="dialog sync-dialog" role="dialog" aria-modal="true" aria-label="Device sync">
      <div class="dialog-head">
        <div>
          <h2>{{ title }}</h2>
        </div>
        <button class="icon-button" type="button" aria-label="Close" :disabled="leavingMesh" @click="emit('dismiss')">×</button>
      </div>

      <section v-for="request in visiblePendingJoins" :key="request.id" class="join-request" aria-label="Access request">
        <h3>{{ request.name }} wants to join</h3>
        <code>{{ request.personId.slice(0, 12) }}</code>
        <label>Role<select v-model="request.role" aria-label="Participant role"><option value="visitor">Visitor — view only</option><option value="editor">Editor — edit items</option></select></label>
        <label v-if="request.ownerConnectionRequested" class="sync-checkbox-item"><input v-model="request.followOwner" type="checkbox" aria-label="Connect all my boards, including future boards" />Connect all my boards, including future boards</label>
        <p v-if="request.followOwner" class="dialog-copy">The selected role applies to all boards you own now and create later. Rusty keeps its own identity.</p>
        <div class="dialog-actions"><button class="button button-primary" @click="emit('decideJoin', request.id, true)">Approve access</button><button class="button" @click="emit('decideJoin', request.id, false)">Decline</button></div>
      </section>
      <template v-if="step === 'members'">
        <div class="sync-tabs" role="tablist" aria-label="Sync tasks" @keydown="navigateTabs">
          <button v-for="tab in tabs" :id="`${tabId}-${tab}-tab`" :key="tab" type="button" role="tab"
            :data-tab="tab" :aria-selected="activeTab === tab" :aria-controls="`${tabId}-${tab}-panel`"
            :tabindex="activeTab === tab ? 0 : -1" :disabled="leavingMesh" @click="activeTab = tab">{{ tab }}</button>
        </div>
        <p v-if="meshActionError" class="sync-error" role="alert">{{ meshActionError }}</p>
        <p v-if="leavingMesh" class="dialog-copy" role="status">Leaving workspace mesh…</p>
        <div v-show="activeTab === 'Participants'" :id="`${tabId}-Participants-panel`" role="tabpanel" :aria-labelledby="`${tabId}-Participants-tab`">
        <p class="mesh-connection-summary" :class="{ 'is-warning': live !== false && !workspaceConnected }" role="status">
          <strong>{{ workspaceConnected ? "Devices connected" : workspaceReconnecting ? "Devices reconnecting" : "Devices offline" }}</strong>
          · {{ connectionSummary }}
        </p>
        <section v-if="networkOnline !== false && rejectedSource" class="sync-error" role="status" aria-label="Changes rejected">
          <p><strong>Changes rejected by this board.</strong>
            <template v-if="rejectedSource.device"> Source: {{ rejectedSource.device.name }} ({{ rejectedSource.source }}).</template>
            <template v-else> Source device {{ rejectedSource.source }}.</template>
          </p>
          <p>This board kept its accepted data. The source still has rejected changes. Removing its access stops attempts for this workspace; review its local copy first if needed.</p>
          <button v-if="rejectedSource.member" class="button" type="button" @click="reviewRejectedSource">Review source device</button>
          <p v-else>Source device is not currently listed among known members.</p>
          <button class="button button-quiet" type="button" @click="activeTab = 'Advanced'">Technical details</button>
        </section>
        <p v-else-if="networkOnline !== false && meshDiagnostic && (meshMembers || []).some(member => !member.self)" class="sync-error" role="status">{{ workspaceConnected ? "Sync issue:" : "Reconnect:" }} {{ meshDiagnostic }}</p>
        <p class="dialog-copy">People and their known devices trusted by {{ invitationWorkspaceTitle || "this workspace" }}.</p>
        <p class="mesh-member-help">A person can have more than one device. Select a person to see the devices known here.</p>
        <div class="mesh-member-list" role="list" aria-label="Mesh members">
          <button
            v-for="member in peopleMembers"
            :key="member.personId"
            class="mesh-member"
            :class="{ 'is-selected': selectedMemberId === member.personId }"
            type="button"
            :aria-pressed="selectedMemberId === member.personId"
            @click="selectedMemberId = member.personId"
          >
            <RustyMark compact v-if="member.deviceList.length && member.deviceList.every(device => isKeeper(device.userAgent))" :online="member.online" :reconnecting="member.reconnecting" />
            <ParticipantAvatar v-else :person-id="member.personId" :avatar-data="memberAvatars?.[member.personId]" /><span class="mesh-member-presence" :class="member.online ? 'is-online' : member.reconnecting ? 'is-reconnecting' : 'is-offline'" aria-hidden="true"></span>
            <span class="mesh-member-name"><strong>{{ member.deviceList.some(device => isKeeper(device.userAgent)) ? keeperDisplayName(member.name) : member.name }}</strong><small>{{ member.devices }} known {{ member.devices === 1 ? 'device' : 'devices' }}{{ member.self ? ' · You' : '' }}</small></span>
            <span class="mesh-member-role">{{ member.personId === succession?.successorPersonId ? 'successor' : member.role }}</span>
          </button>
          <p v-if="!peopleMembers.length" class="mesh-member-empty">No people connected to this board.</p>
        </div>

        <section v-if="selectedMember" class="mesh-member-action" aria-label="Selected mesh member">
          <strong>{{ selectedMember.name }}</strong>
          <ul class="mesh-device-list" role="list" :aria-label="`Devices for ${selectedMember.name}`">
            <li v-for="device in selectedMember.deviceList" :key="device.deviceId" class="mesh-device">
              <div class="mesh-device-head">
                <RustyMark compact v-if="isKeeper(device.userAgent)" :online="device.online" :reconnecting="device.reconnecting" />
                <span v-else class="mesh-device-presence" :class="device.online ? 'is-online' : device.reconnecting ? 'is-reconnecting' : 'is-offline'" aria-hidden="true"></span>
                <strong>{{ device.deviceId === localDeviceId ? 'This device' : isKeeper(device.userAgent) ? keeperDisplayName(device.name) : device.name }}</strong>
                <code>{{ device.deviceId.slice(0, 8) }}</code>
              </div>
              <small class="mesh-device-platform">{{ device.description }}</small>
              <small class="mesh-device-status">{{ deviceConnectionLabel(device) }}</small>
              <DeviceRemovalControl v-if="device.deviceId !== localDeviceId && (canManageMesh || (selectedMember.self && currentRole === 'editor'))"
                :person-id="selectedMember.personId" :device-id="device.deviceId" :name="device.name" :active-workspace-id="activeWorkspaceId"
                :removable-device-workspaces="removableDeviceWorkspaces" :remove-device="removeDevice" />
              <small v-if="!isKeeper(device.userAgent)">{{ device.tabs }} known {{ device.tabs === 1 ? 'browser session' : 'browser sessions' }} · session count may include tabs no longer open</small>
              <small v-if="!device.online && !device.reconnecting">Last seen {{ new Date(device.lastSeen).toLocaleString() }}</small>
              <small v-if="device.userAgent">User agent available in Advanced.</small>
            </li>
          </ul>
          <button v-if="canManageMesh && selectedMember.role === 'visitor'" class="button" type="button" @click="emit('promotePeer', selectedMember.personId)">Make editor</button>
          <p v-if="canManageMesh && selectedMember.role !== 'owner' && !selectedMember.online" class="dialog-copy">This member must be online before ownership can move.</p>
          <p v-else-if="canManageMesh && selectedMember.role !== 'owner'" class="dialog-copy">They become owner. You keep editor access.</p>
          <button
            v-if="canManageMesh && selectedMember.role !== 'owner'"
            class="button button-danger"
            type="button"
            :disabled="!selectedMember.online || Boolean(transferringOwnership)"
            @click="emit('transferOwnership', selectedMember.personId)"
          >{{ transferringOwnership === selectedMember.personId ? 'Transferring…' : 'Transfer ownership' }}</button>
          <button v-if="canManageMesh && !selectedMember.self && selectedMember.role !== 'owner' && !confirmingRemoval" class="button button-danger" type="button"
            :disabled="Boolean(revokingPersonId)" @click="confirmingRemoval = selectedMember.personId">Remove participant</button>
          <section v-if="canManageMesh && !selectedMember.self && selectedMember.role !== 'owner' && confirmingRemoval === selectedMember.personId" class="mesh-member-action" aria-label="Remove participant confirmation">
            <p>Remove {{ selectedMember.name }} and all their devices from {{ invitationWorkspaceTitle || 'this workspace' }}? Other workspaces are kept. Existing copies cannot be erased.</p>
            <div class="dialog-actions">
              <button class="button button-danger" type="button" :disabled="Boolean(revokingPersonId)" @click="emit('revokePerson', confirmingRemoval)">{{ revokingPersonId ? 'Removing…' : 'Remove participant and all devices' }}</button>
              <button class="button button-quiet" type="button" :disabled="Boolean(revokingPersonId)" @click="confirmingRemoval = ''">Cancel</button>
            </div>
          </section>
        </section>
        <div class="dialog-actions sync-primary-actions"><button v-if="canManageMesh" class="button" type="button" @click="emit('selectSyncWorkspace')">Add someone</button></div>
        </div>
        <div v-show="activeTab === 'Advanced'" :id="`${tabId}-Advanced-panel`" role="tabpanel" :aria-labelledby="`${tabId}-Advanced-tab`">
          <section class="sync-advanced" aria-label="Connection diagnostics">
            <h3>Connection diagnostics</h3>
            <p v-if="meshDiagnostic" class="dialog-copy">{{ meshDiagnostic }}</p>
            <code v-if="rejectedSource">{{ rejectedSource.diagnostic }}</code>
            <div v-for="member in peopleMembers" :key="member.personId">
              <p><strong>{{ member.name }}</strong></p>
              <div v-for="device in member.deviceList" :key="device.deviceId" class="mesh-device-ua">
                <small>{{ device.name }} · {{ device.deviceId }}</small>
                <code v-if="device.userAgent">User agent: {{ device.userAgent }}</code>
              </div>
            </div>
          </section>
        <section v-if="hasMesh" class="sync-advanced">
          <h3>Ownership succession</h3>
          <label v-if="canManageMesh">Participant<select v-model="selectedMemberId" aria-label="Recovery participant"><option value="">Choose participant</option><option v-for="member in peopleMembers" :key="member.personId" :value="member.personId">{{ member.name }}</option></select></label>
          <OwnershipRecoveryPanel :members="peopleMembers" :selected-person-id="selectedMemberId" :has-mesh="hasMesh" :succession="succession"
            :current-role="currentRole" :current-person-id="currentPersonId" :can-manage-mesh="canManageMesh" :can-claim-succession="canClaimSuccession"
            @set-successor="emit('setSuccessor', $event)" @vote-successor="emit('voteSuccessor', $event)" @claim-succession="emit('claimSuccession')" />
        </section>
        <section class="sync-advanced" aria-label="Sync controls"><h3>Sync controls</h3>
        <section v-if="confirmingLeave && hasMesh" class="mesh-member-action" aria-label="Leave mesh confirmation">
          <strong>Leave this workspace mesh?</strong>
          <p class="dialog-copy">Your identity leaves this workspace on all its devices. Your identity and other workspaces are kept. Local data stays as a read-only copy. An owner must transfer ownership first; another workspace device must be connected.</p>
          <div class="dialog-actions">
            <button class="button button-danger" type="button" :disabled="leavingMesh" @click="emit('leaveMesh')">{{ leavingMesh ? 'Leaving workspace…' : 'Leave mesh, keep copy' }}</button>
            <button class="button button-quiet" type="button" :disabled="leavingMesh" @click="confirmingLeave = false">Cancel</button>
          </div>
        </section>
        <div class="dialog-actions sync-primary-actions">
          <button v-if="live" class="button button-quiet" type="button" @click="emit('stop')">Stop live sync</button>
          <button v-else class="button button-quiet" type="button" @click="emit('start')">Start live sync</button>
          <button v-if="hasMesh" class="button button-danger" type="button" @click="confirmingLeave = true">Leave mesh</button>
        </div>
        </section>
        </div>
        <div v-show="activeTab === 'Rusty'" :id="`${tabId}-Rusty-panel`" role="tabpanel" :aria-labelledby="`${tabId}-Rusty-tab`">
          <RustyPanel v-if="blindReplication && activeWorkspaceId" :controller="blindReplication" :workspace-id="activeWorkspaceId" :owner="currentRole === 'owner'" />
          <p v-else class="dialog-copy">Rusty is unavailable for this workspace.</p>
        </div>
        <div v-show="activeTab === 'Backups'" :id="`${tabId}-Backups-panel`" role="tabpanel" :aria-labelledby="`${tabId}-Backups-tab`">
        <WorkspaceFileActions @export="emit('export')" @import="emit('import')" />
        </div>
      </template>
      <!-- Step: Direct Workspace Selection (supersedes former preliminary chooser) -->
      <template v-else-if="step === 'workspace-select' || step === 'workspace-host-select' || step === 'chooser'">
        <p class="dialog-copy">Invite another person. Choose workspaces; select their role when they request access.</p>
        <div class="sync-workspace-list">
          <label
            v-for="ws in invitationChoices"
            :key="ws.id"
            class="sync-checkbox-item"
          >
            <input
              type="checkbox"
              :aria-label="ws.label"
              :value="ws.id"
              :checked="isWorkspaceSelected(ws.id)"
              @change="toggleWorkspace(ws.id)"
            />
            <span>{{ ws.title }}<small v-if="ws.detail" class="sync-workspace-detail">{{ ws.detail }}</small></span>
          </label>
        </div>

        <div class="dialog-actions sync-primary-actions">
          <button
            class="button button-primary"
            type="button"
            aria-label="Generate link"
            :disabled="!hasSelection"
            @click="emit('generateWorkspaceInvite')"
          >
            Generate link
          </button>
          <button class="button button-quiet" type="button" aria-label="Cancel" @click="emit('dismiss')">Cancel</button>
        </div>

        <!-- Distinct Secondary Action: Add my device / Sync all -->
        <section class="sync-section">
          <p class="sync-section-copy">Your own device only. Uses your identity and Owner access to workspaces you own.</p>
          <button
            class="sync-section-action"
            type="button"
            aria-label="Add my device"
            @click="emit('selectSyncAll')"
          >
            <span>Add my device</span>
            <small>Your identity</small>
          </button>
        </section>

        <WorkspaceFileActions @export="emit('export')" @import="emit('import')" />
      </template>

      <template v-else-if="step === 'enroll-host-preparing'">
        <p class="dialog-copy sync-step-title" role="status">Preparing secure enrollment link…</p>
        <p class="dialog-copy">Keep this tab open while tincanban starts a temporary encrypted listener.</p>
      </template>

      <!-- Enrollment and workspace invitation display -->
      <template v-else-if="isEnrollmentHost || step === 'workspace-host'">
        <p class="dialog-copy sync-step-title">{{ isEnrollmentHost ? "Add your second device" : "Invite someone" }}</p>
        <img v-if="qrCode" :src="qrCode" alt="Pairing QR code" aria-label="Pairing QR code" class="pairing-qr" />
        <p v-if="isEnrollmentHost" class="dialog-copy">Scan this with your other device or copy the enrollment link below:</p>
        <div class="dialog-actions" :class="{ 'sync-wrap-actions': isEnrollmentHost }">
          <button class="button button-primary" type="button" @click="emit('copy')">{{ isEnrollmentHost ? "Copy enrollment link" : "Copy invite link" }}</button>
        </div>
        <p v-if="copyNotice" class="sync-success" role="status">{{ copyNotice }}</p>
        <label class="pairing-paste">
          <span>Pairing link</span>
          <textarea aria-label="Pairing link" rows="2" readonly :value="inviteUrl" @focus="selectPairingLink" @click="selectPairingLink"></textarea>
        </label>

        <!-- Authentication code and approval -->
        <div v-if="step === 'enroll-host-pending'" class="approval-card">
          <p class="dialog-copy">{{ enrollmentDeviceName }} requests your identity and Owner access.</p>
          <span class="detail-label">Authentication code</span>
          <div class="auth-code">{{ authCode }}</div>
          <p class="dialog-copy sync-help">Verify this code matches on your second device before approving.</p>
          <button class="button button-primary" type="button" @click="emit('approveDevice')">Approve device</button>
          <button class="button" type="button" @click="emit('declineDevice')">Decline device</button>
        </div>
      </template>

      <!-- Step 2: Enroll host completed -->
      <template v-else-if="step === 'enroll-host-done'">
        <p class="sync-success sync-result" role="status">Device enrolled</p>
        <p class="dialog-copy">Your device has received your workspaces. Changes sync automatically.</p>
      </template>

      <!-- Step 5: Enroll guest request -->
      <EnrollmentRequest v-else-if="step === 'enroll-guest'" :conflict="enrollmentConflict" @request="emit('requestEnrollment', $event)" />

      <!-- Step 6: Enroll guest waiting -->
      <template v-else-if="step === 'enroll-guest-waiting'">
        <p class="dialog-copy sync-step-title">Waiting for approval</p>
        <p class="dialog-copy sync-help">Confirm that this code matches on your primary device:</p>
        <div class="auth-code">{{ authCode }}</div>
        <button class="button" type="button" @click="emit('stop')">Cancel</button>
      </template>

      <template v-else-if="step === 'enroll-syncing'">
        <p role="status" class="dialog-copy">Approved. Saving workspaces and connecting…</p>
      </template>

      <!-- Step 7: Enroll guest done -->
      <template v-else-if="step === 'enroll-guest-done'">
        <p class="sync-success sync-result" role="status">Device enrolled</p>
        <p class="dialog-copy">Your workspaces are saved on this device. Changes sync automatically.</p>
      </template>

      <!-- Step 8: Workspace guest join -->
      <template v-else-if="step === 'workspace-guest'">
        <p class="dialog-copy">You have been invited to join {{ invitationWorkspaceTitle || "Workspace" }}</p>
        <ul v-if="guestWorkspaces.length > 1" class="guest-workspace-list">
          <li v-for="ws in guestWorkspaces" :key="ws.id">
            {{ ws.title }}
          </li>
        </ul>
        <div class="dialog-actions sync-step-actions">
          <button class="button button-primary" type="button" @click="emit('acceptAndJoin')">Accept and join</button>
        </div>
      </template>

      <template v-else-if="step === 'workspace-merge-confirm'">
        <p class="dialog-copy">A local copy of {{ invitationWorkspaceTitle || "this workspace" }} already exists.</p>
        <p class="dialog-copy">Existing local changes and incoming workspace history will be merged.</p>
        <div class="dialog-actions sync-step-actions">
          <button class="button button-primary" type="button" @click="emit('acceptAndJoin')">Merge and join</button>
          <button class="button button-quiet" type="button" @click="emit('dismiss')">Cancel</button>
        </div>
      </template>

      <template v-else-if="step === 'workspace-guest-waiting'">
        <p class="dialog-copy" role="status">Waiting for owner approval, then receiving workspaces… Keep both devices open.</p>
        <div class="dialog-actions">
          <button class="button button-quiet" type="button" @click="emit('stop')">Cancel</button>
        </div>
      </template>

      <template v-else-if="step === 'workspace-reconnecting'">
        <p class="dialog-copy" role="status">Connection interrupted. Retrying automatically…</p>
        <div class="dialog-actions">
          <button class="button button-quiet" type="button" @click="emit('dismiss')">Keep working</button>
          <button class="button button-quiet" type="button" @click="emit('stop')">Stop sync</button>
        </div>
      </template>

      <!-- Step 9: Workspace guest done -->
      <template v-else-if="step === 'workspace-guest-done'">
        <p class="sync-success sync-result" role="status">Connected to {{ invitationWorkspaceTitle || "Workspace" }}</p>
        <ul v-if="guestWorkspaces.length > 1" class="guest-workspace-list">
          <li v-for="ws in guestWorkspaces" :key="ws.id">
            {{ ws.title }}
          </li>
        </ul>
      </template>

      <template v-else-if="step === 'synced'">
        <p class="sync-success" role="status">Live sync is on. Changes appear in both tabs.</p>
        <div class="dialog-actions">
          <button class="button button-primary" type="button" @click="emit('selectSyncWorkspace')">Invite peers</button>
          <button class="button button-quiet" type="button" @click="emit('stop')">Stop live sync</button>
        </div>
      </template>

      <template v-else-if="step === 'workspace-reconnect-confirm'">
        <section v-if="!reconnectCancelled" class="mesh-member-action" role="region" aria-label="Confirm device reconnection">
          <p class="dialog-copy">This device was removed. Reconnect with a new device key? Your identity and local boards stay saved. The old key stays revoked; the owner must approve access.</p>
          <div class="dialog-actions"><button class="button button-primary" type="button" @click="emit('reconnectDevice')">Confirm reconnection</button><button class="button button-quiet" type="button" @click="reconnectCancelled = true">Cancel</button></div>
        </section>
        <div v-else class="dialog-actions"><button class="button button-primary" type="button" @click="reconnectCancelled = false">Reconnect this device</button><button class="button button-quiet" type="button" @click="emit('dismiss')">Dismiss</button></div>
      </template>

      <!-- Step 11: Error -->
      <template v-else-if="step === 'error'">
        <p class="sync-error" role="alert">{{ error }}</p>
        <section v-if="canReconnectDevice && confirmingReconnect" class="mesh-member-action" role="region" aria-label="Confirm device reconnection">
          <p class="dialog-copy">Reconnect this device with a new device key. Your identity and local boards stay saved. The old key stays revoked; the owner must approve access.</p>
          <div class="dialog-actions"><button class="button button-primary" type="button" @click="confirmingReconnect = false; emit('reconnectDevice')">Confirm reconnection</button><button class="button button-quiet" type="button" @click="confirmingReconnect = false">Cancel</button></div>
        </section>
        <div class="dialog-actions sync-step-actions">
          <button v-if="canReconnectDevice && !confirmingReconnect" class="button button-primary" type="button" @click="confirmingReconnect = true">Reconnect this device</button>
          <button class="button button-quiet" type="button" @click="emit('dismiss')">Dismiss</button>
        </div>
      </template>
    </section>
  </ModalLayer>
</template>

<style scoped src="./SyncDialog.css"></style>
