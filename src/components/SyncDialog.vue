<script setup lang="ts">
import ParticipantAvatar from "./ParticipantAvatar.vue"
import RustyPanel from "./RustyPanel.vue"
import DeviceSyncProblems from "./DeviceSyncProblems.vue"
import OwnershipRecoveryPanel from "./OwnershipRecoveryPanel.vue"
import type { BlindReplicationController } from "../app/blindReplication"
import { describeUserAgent, deviceDisplayName, isKeeper, type MeshMemberView } from "../ui/deviceInfo"
import EnrollmentRequest from "./EnrollmentRequest.vue"
import DeviceRemovalControl from "./DeviceRemovalControl.vue"
import MyDeviceRemovalControl from "./MyDeviceRemovalControl.vue"
import OwnerReconnectDialog from "./OwnerReconnectDialog.vue"
import DialogWindow from "./DialogWindow.vue"
import type { useMyDeviceRemoval } from "../app/useMyDeviceRemoval"
import { myDeviceRemovalComplete } from "../app/useMyDeviceRemoval"
import { syncDialogConnectionStatus } from "./syncDialogConnectionStatus"
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import type { SyncStep, SuccessionView, OwnerReconnectReview } from "../app/syncTypes"

const props = defineProps<{
  workspaceId?: string
  myDeviceRemoval?: ReturnType<typeof useMyDeviceRemoval>
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
  enrollmentSameIdentity?: boolean
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
  meshPresence?: "connected" | "reconnecting" | "offline" | "empty"
  workspaceConnected?: boolean
  workspaceReconnecting?: boolean
  meshDiagnostic?: string
  retryAt?: number
  networkOnline?: boolean
  live?: boolean
  ownerReconnectReview?: OwnerReconnectReview | null

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
  (e: "startOwnerReconnect"): void
  (e: "approveOwnerReconnect"): void
  (e: "cancelOwnerReconnect"): void
  (e: "stop"): void
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
watch(() => props.step, () => { reconnectCancelled.value = false })
const selectedMember = computed(() => peopleMembers.value.find(member => member.personId === selectedMemberId.value))
const peopleMembers = computed(() => (props.meshMembers ?? []).filter(member => !member.deviceList.length || !member.deviceList.every(device => isKeeper(device.userAgent))).map(member => {
  const deviceList = member.deviceList.filter(device => !isKeeper(device.userAgent))
  if (member.self) for (const device of props.blindReplication?.registeredDevices.value ?? []) {
    if (!deviceList.some(known => known.deviceId === device.deviceId)) deviceList.push({ deviceId: device.deviceId, name: device.displayName,
      online: device.deviceId === props.localDeviceId, reconnecting: false, lastSeen: "", description: describeUserAgent(), tabs: 0 })
  }
  const activeDevices = member.self ? deviceList.filter(device => !props.myDeviceRemoval?.jobs.value.some(job => job.deviceId === device.deviceId && myDeviceRemovalComplete(job))) : deviceList
  return { ...member, deviceList: activeDevices, devices: activeDevices.length,
    onlineDevices: activeDevices.filter(device => device.online).length,
    online: activeDevices.some(device => device.online), reconnecting: activeDevices.some(device => device.reconnecting) }
}))
const removedDeviceRecords = computed(() => props.myDeviceRemoval?.jobs.value.filter(myDeviceRemovalComplete) ?? [])

watch(peopleMembers, members => {
  if (!members.some(member => member.personId === selectedMemberId.value)) selectedMemberId.value = ""
}, { immediate: true })
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => { clock = setInterval(() => { now.value = Date.now() }, 500) })
onBeforeUnmount(() => clearInterval(clock))
const connectionStatus = computed(() => syncDialogConnectionStatus({ ...props, now: now.value }))

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
  <DialogWindow window-id="device-sync" :workspace-id="workspaceId ?? 'local'" :title="title" aria-label="Device sync" :busy="leavingMesh" @close="emit('dismiss')">
    <template #header><h2 class="sync-window-title">{{ title }}</h2></template>
    <section class="dialog dialog-window-content sync-dialog">
      <DeviceSyncProblems v-if="blindReplication" :controller="blindReplication" />

      <OwnerReconnectDialog v-if="step.startsWith('owner-reconnect-')" :step="step" :invite-url="inviteUrl"
        :qr-code="qrCode" :copy-notice="copyNotice" :error="error" :review="ownerReconnectReview ?? null"
        @copy="emit('copy', $event)" @approve="emit('approveOwnerReconnect')"
        @cancel="emit('cancelOwnerReconnect')" @dismiss="emit('dismiss')" />

      <section v-for="request in visiblePendingJoins" :key="request.id" class="join-request" aria-label="Access request">
        <h3>{{ request.name }} wants to join</h3>
        <code>{{ request.personId.slice(0, 12) }}</code>
        <label>Role<select v-model="request.role" aria-label="Participant role"><option value="visitor">Visitor — view only</option><option value="editor">Editor — edit items</option></select></label>
        <label v-if="request.ownerConnectionRequested" class="sync-checkbox-item"><input v-model="request.followOwner" type="checkbox" aria-label="Connect all my boards, including future boards" />Connect all my boards, including future boards</label>
        <p v-if="request.followOwner" class="dialog-copy">The selected role applies to all boards you own now and create later. Rusty keeps its own identity.</p>
        <div class="dialog-actions"><button class="button button-primary" @click="emit('decideJoin', request.id, true)">Approve access</button><button class="button" @click="emit('decideJoin', request.id, false)">Decline</button></div>
      </section>
      <template v-if="step === 'members'">
        <p v-if="meshActionError" class="sync-error" role="alert">{{ meshActionError }}</p>
        <p v-if="leavingMesh" class="dialog-copy" role="status">Leaving workspace mesh…</p>
        <div>
        <p class="mesh-connection-summary" :class="{ 'is-warning': connectionStatus.warning }" role="status">
          <strong>{{ connectionStatus.title }}</strong><span> · {{ connectionStatus.message }}</span>
        </p>
        <section v-if="networkOnline !== false && rejectedSource" class="sync-error" role="status" aria-label="Changes rejected">
          <p><strong>Changes rejected by this board.</strong>
            <template v-if="rejectedSource.device"> Source: {{ deviceDisplayName(rejectedSource.device) }} ({{ rejectedSource.source }}).</template>
            <template v-else> Source device {{ rejectedSource.source }}.</template>
          </p>
          <p>This board kept its accepted data. The source still has rejected changes. Removing its access stops attempts for this workspace; review its local copy first if needed.</p>
          <button v-if="rejectedSource.member" class="button" type="button" @click="reviewRejectedSource">Review source device</button>
          <p v-else>Source device is not currently listed among known members.</p>
        </section>
        <p v-else-if="networkOnline !== false && meshDiagnostic && (meshMembers || []).some(member => !member.self)" class="sync-error" role="status">{{ workspaceConnected ? "Sync issue:" : "Reconnect:" }} {{ meshDiagnostic }}</p>
        <div class="sync-participant-browser">
        <div class="mesh-member-list" role="list" aria-label="Mesh members">
          <button
            v-for="member in peopleMembers"
            :key="member.personId"
            class="mesh-member"
            :class="{ 'is-selected': selectedMemberId === member.personId }"
            type="button"
            :aria-pressed="selectedMemberId === member.personId"
            :aria-expanded="selectedMemberId === member.personId"
            @click="selectedMemberId = selectedMemberId === member.personId ? '' : member.personId"
          >
            <ParticipantAvatar :person-id="member.personId" :avatar-data="memberAvatars?.[member.personId]" /><span class="mesh-member-presence" :class="member.online ? 'is-online' : member.reconnecting ? 'is-reconnecting' : 'is-offline'" aria-hidden="true"></span>
            <span class="mesh-member-name"><strong>{{ member.name }}</strong><small>{{ member.devices }} {{ member.devices === 1 ? 'device' : 'devices' }}{{ member.self ? ' · You' : '' }}</small>
              <span class="mesh-member-role">{{ member.role }}{{ member.personId === succession?.successorPersonId ? ' · Named successor' : '' }}</span>
            </span>
          </button>
          <p v-if="!peopleMembers.length" class="mesh-member-empty">No people connected to this board.</p>
        </div>

        <section v-if="selectedMember" class="mesh-member-action" aria-label="Selected mesh member">
          <strong>{{ selectedMember.name }}</strong>
          <ul class="mesh-device-list" role="list" :aria-label="`Devices for ${selectedMember.name}`">
            <li v-for="device in selectedMember.deviceList" :key="device.deviceId" class="mesh-device">
              <div class="mesh-device-head">
                <span class="mesh-device-presence" :class="device.online ? 'is-online' : device.reconnecting ? 'is-reconnecting' : 'is-offline'" aria-hidden="true"></span>
                <strong>{{ deviceDisplayName(device) }}</strong>
              </div>
              <div class="mesh-device-actions">
                <small class="mesh-device-status">{{ deviceConnectionLabel(device) }}</small>
                <MyDeviceRemovalControl v-if="selectedMember.self && device.deviceId !== localDeviceId && myDeviceRemoval"
                  :device-id="device.deviceId" :name="deviceDisplayName(device)" :workspace-id="activeWorkspaceId" :controller="myDeviceRemoval" />
                <DeviceRemovalControl v-else-if="!selectedMember.self && device.deviceId !== localDeviceId && canManageMesh"
                  :person-id="selectedMember.personId" :device-id="device.deviceId" :name="deviceDisplayName(device)" :active-workspace-id="activeWorkspaceId"
                  :removable-device-workspaces="removableDeviceWorkspaces" :remove-device="removeDevice" />
              </div>
              <details class="mesh-device-details">
                <summary>Details</summary>
                <small>{{ device.description || 'Browser / OS unknown' }}</small>
                <code>{{ device.deviceId }}</code>
                <small v-if="device.tabs">{{ device.tabs }} known {{ device.tabs === 1 ? 'browser session' : 'browser sessions' }}</small>
                <small v-if="device.lastSeen && !device.online && !device.reconnecting">Last seen {{ new Date(device.lastSeen).toLocaleString() }}</small>
                <small v-if="device.tabs">Session counts may include closed tabs.</small>
              </details>
            </li>
          </ul>
          <details v-if="selectedMember.self && removedDeviceRecords.length" class="removed-device-history">
            <summary>Removed device records ({{ removedDeviceRecords.length }})</summary>
            <p class="dialog-copy">Kept separately from active devices on this browser. Signed workspace and server revocations remain authoritative; catalog records on other devices can still contain this device.</p>
            <div v-for="record in removedDeviceRecords" :key="record.deviceId" class="mesh-device">
              <strong>{{ deviceDisplayName(record) }}</strong><code>{{ record.deviceId.slice(0, 8) }}</code>
              <MyDeviceRemovalControl v-if="myDeviceRemoval" :device-id="record.deviceId" :name="deviceDisplayName(record)" :workspace-id="activeWorkspaceId" :controller="myDeviceRemoval" />
            </div>
          </details>
          <OwnershipRecoveryPanel :members="peopleMembers" :selected-person-id="selectedMemberId" :has-mesh="hasMesh" :succession="succession"
            :current-role="currentRole" :current-person-id="currentPersonId" :can-manage-mesh="canManageMesh" :can-claim-succession="canClaimSuccession"
            @set-successor="emit('setSuccessor', $event)" @vote-successor="emit('voteSuccessor', $event)" @claim-succession="emit('claimSuccession')" />
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
        </div>
        <div class="dialog-actions sync-primary-actions">
          <button v-if="currentRole === 'editor' || currentRole === 'visitor'" class="button" type="button" @click="emit('startOwnerReconnect')">Connect owner device</button>
          <button v-if="canManageMesh" class="button" type="button" @click="emit('selectSyncWorkspace')">Add someone</button>
          <button class="button" type="button" @click="emit('selectSyncAll')">Add my device</button>
        </div>
        </div>
        <section class="sync-storage" aria-label="Persistent storage">
          <RustyPanel v-if="blindReplication && activeWorkspaceId" :controller="blindReplication" :workspace-id="activeWorkspaceId" :owner="currentRole === 'owner'" />
          <p v-else class="dialog-copy">Rusty is unavailable for this workspace.</p>
        </section>
        <section v-if="confirmingLeave && hasMesh" class="mesh-member-action" aria-label="Leave mesh confirmation">
          <strong>Leave this workspace mesh?</strong>
          <p class="dialog-copy">Your identity leaves this workspace on all its devices. Your identity and other workspaces are kept. Local data stays as a read-only copy. An owner must transfer ownership first; another workspace device must be connected.</p>
          <div class="dialog-actions">
            <button class="button button-danger" type="button" :disabled="leavingMesh" @click="emit('leaveMesh')">{{ leavingMesh ? 'Leaving workspace…' : 'Leave mesh, keep copy' }}</button>
            <button class="button button-quiet" type="button" :disabled="leavingMesh" @click="confirmingLeave = false">Cancel</button>
          </div>
        </section>
        <div class="dialog-actions sync-primary-actions">
          <button v-if="hasMesh" class="button button-danger" type="button" :disabled="currentRole === 'owner'" @click="confirmingLeave = true">Leave mesh</button>
        </div>
        <p v-if="hasMesh && currentRole === 'owner'" class="dialog-copy">Transfer ownership in Participants before leaving this workspace.</p>
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
          <p v-if="enrollmentSameIdentity" class="dialog-copy">This device is already in your Identity. Approving adds the selected board and keeps your Identity profile in sync through Rusty.</p>
          <p v-else class="dialog-copy">{{ enrollmentDeviceName }} requests your identity and Owner access.</p>
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
  </DialogWindow>
</template>

<style scoped src="./SyncDialog.css"></style>
