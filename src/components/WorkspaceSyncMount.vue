<script setup lang="ts">
import type { Component } from "vue"
import type { BlindReplicationController } from "../app/blindReplication"
import type { SuccessionView } from "../app/syncTypes"
import type { OwnerReconnectReview } from "../sync/deviceSyncState"
import type { SyncStep } from "../sync/useDeviceSync"
import type { useMyDeviceRemoval } from "../app/useMyDeviceRemoval"
import type { MeshMemberView } from "../ui/deviceInfo"

type RefValue<T> = { value: T }
type JoinRequest = { id: string; name: string; personId: string; role: "visitor" | "editor"; ownerConnectionRequested?: boolean; followOwner?: boolean }

defineProps<{
  dialog: Component
  sync: {
    pendingJoins: RefValue<JoinRequest[]>
    decideJoin: (id: string, approve: boolean) => void
    step: RefValue<SyncStep>
    title: RefValue<string>
    qrCode: RefValue<string>
    inviteUrl: RefValue<string>
    copyNotice: RefValue<string>
    ownerReconnectReview: RefValue<OwnerReconnectReview | null>
    startOwnerReconnect: () => void
    approveOwnerReconnect: () => void
    cancelOwnerReconnect: () => void
    error: RefValue<string>
    canReconnectDevice: RefValue<boolean>
    reconnectDevice: () => void
    authCode: RefValue<string>
    invitationWorkspaceTitle: RefValue<string>
    invitationWorkspaces: RefValue<{ id: string; title: string }[]>
    availableWorkspaces: RefValue<{ id: string; title: string }[]>
    selectedWorkspaceIds: RefValue<string[]>
    selectedWorkspaceId: RefValue<string>
    localDeviceId: RefValue<string>
    removableDeviceWorkspaces: (personId: string, deviceId: string) => Promise<{ id: string; title: string }[]>
    removeDevice: (personId: string, deviceId: string, workspaceIds: string[]) => Promise<void>
    enrollmentConflict: RefValue<{ currentPersonId: string; currentName: string; targetPersonId: string } | null>
    meshPeers: RefValue<{ workspaceId: string; revokedAt?: string }[]>
    meshDiagnostic: RefValue<string>
    networkOnline: RefValue<boolean>
    isEnabled: RefValue<boolean>
    selectSyncWorkspace: () => void
    requestEnrollment: (replaceIdentity: boolean) => void
    enrollmentDeviceName: RefValue<string>
    enrollmentSameIdentity: RefValue<boolean>
    approveEnrollment: () => void
    declineEnrollment: () => void
    acceptWorkspaceJoin: () => void
    copyInvite: (url?: string) => void
    dismiss: () => void
    stopLiveSync: () => void
  }
  chat: { personId: RefValue<string> }
  workspaceId: string
  memberAvatars: Record<string, string>
  revokingPeer: string
  blindReplication: BlindReplicationController
  myDeviceRemoval: ReturnType<typeof useMyDeviceRemoval>
  meshMembers: MeshMemberView[]
  currentRole: "owner" | "editor" | "visitor"
  succession: SuccessionView | undefined
  canClaimSuccession: boolean
  canManageAccess: boolean
  transferringOwnership: string
  leavingMesh: boolean
  peerAccessError: string
  devicePresence: "connected" | "reconnecting" | "offline" | "empty"
  meshPresence: "connected" | "reconnecting" | "offline" | "empty"
  activeMeshRetryAt: number | undefined
  identityPortalOrigin: string
  addMyDevice: () => void
  generateWorkspaceInvite: () => void
  beginEnrollmentSignIn: () => void
  revokeWorkspacePeer: (personId: string) => void
  transferWorkspaceOwnership: (personId: string) => void
  leaveWorkspaceMesh: () => void
  setWorkspaceSuccessor: (personId: string | null) => void
  voteForWorkspaceSuccessor: (personId: string) => void
  claimWorkspaceSuccession: () => void
  promoteWorkspacePeer: (personId: string) => void
}>()

const emit = defineEmits<{
  updateSelectedWorkspaceIds: [ids: string[]]
  updateSelectedWorkspaceId: [id: string]
}>()
</script>

<template>
  <component :is="dialog" :workspace-id="workspaceId" :member-avatars="memberAvatars" :revoking-person-id="revokingPeer" @revoke-person="revokeWorkspacePeer" :blind-replication="blindReplication"
    :my-device-removal="myDeviceRemoval"
    :pending-joins="sync.pendingJoins.value"
    @decide-join="sync.decideJoin"
    :step="sync.step.value"
    :title="sync.title.value"
    :qr-code="sync.qrCode.value"
    :invite-url="sync.inviteUrl.value"
    :copy-notice="sync.copyNotice.value"
    :owner-reconnect-review="sync.ownerReconnectReview.value" @start-owner-reconnect="sync.startOwnerReconnect"
    @approve-owner-reconnect="sync.approveOwnerReconnect" @cancel-owner-reconnect="sync.cancelOwnerReconnect"
    :error="sync.error.value" :can-reconnect-device="sync.canReconnectDevice.value" @reconnect-device="sync.reconnectDevice"
    :auth-code="sync.authCode.value"
    :invitation-workspace-title="sync.invitationWorkspaceTitle.value"
    :invitation-workspaces="sync.invitationWorkspaces.value"
    :available-workspaces="sync.availableWorkspaces.value" :selected-workspace-ids="sync.selectedWorkspaceIds.value"
    :selected-workspace-id="sync.selectedWorkspaceId.value"
    :mesh-members="meshMembers"
    v-bind="{ activeWorkspaceId: workspaceId, localDeviceId: sync.localDeviceId.value,
      removableDeviceWorkspaces: sync.removableDeviceWorkspaces, removeDevice: sync.removeDevice, enrollmentConflict: sync.enrollmentConflict.value }"
    :has-mesh="sync.meshPeers.value.some(peer => peer.workspaceId === workspaceId && !peer.revokedAt)" :current-person-id="chat.personId.value"
    :current-role="currentRole"
    :succession="succession"
    :can-claim-succession="canClaimSuccession"
    :can-manage-mesh="canManageAccess"
    :transferring-ownership="transferringOwnership" :leaving-mesh="leavingMesh"
    :mesh-action-error="peerAccessError"
    :workspace-connected="devicePresence === 'connected'" :workspace-reconnecting="devicePresence === 'reconnecting'"
    :mesh-diagnostic="sync.meshDiagnostic.value"
    :mesh-presence="meshPresence"
    :retry-at="activeMeshRetryAt"
    :network-online="sync.networkOnline.value"
    :live="sync.isEnabled.value"
    @update:selected-workspace-ids="emit('updateSelectedWorkspaceIds', $event)"
    @update:selected-workspace-id="emit('updateSelectedWorkspaceId', $event)"
    @select-sync-all="addMyDevice"
    @select-sync-workspace="sync.selectSyncWorkspace"
    @generate-workspace-invite="generateWorkspaceInvite"
    @transfer-ownership="transferWorkspaceOwnership"
    @leave-mesh="leaveWorkspaceMesh"
    @set-successor="setWorkspaceSuccessor"
    @vote-successor="voteForWorkspaceSuccessor"
    @claim-succession="claimWorkspaceSuccession"
    @promote-peer="promoteWorkspacePeer"
    @request-enrollment="sync.requestEnrollment"
    :enrollment-sign-in-available="Boolean(identityPortalOrigin)" @sign-in-for-enrollment="beginEnrollmentSignIn"
    :enrollment-device-name="sync.enrollmentDeviceName.value"
    :enrollment-same-identity="sync.enrollmentSameIdentity.value"
    @approve-device="sync.approveEnrollment"
    @decline-device="sync.declineEnrollment"
    @accept-and-join="sync.acceptWorkspaceJoin"
    @copy="sync.copyInvite"
    @dismiss="sync.dismiss"
    @stop="sync.stopLiveSync"
  />
</template>
