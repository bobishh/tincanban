<script setup lang="ts">
import type { Component } from "vue"
import type { BlindReplicationController } from "../app/blindReplication"
import type { useAppMesh } from "../app/useAppMesh"
import type { useMyDeviceRemoval } from "../app/useMyDeviceRemoval"
import type { WorkspaceRole } from "../domain/permissions"
import type { useWorkspaceChat } from "../chat/useWorkspaceChat"
import type { useDeviceSync } from "../sync/useDeviceSync"

type Mesh = ReturnType<typeof useAppMesh>

defineProps<{
  dialog: Component
  sync: ReturnType<typeof useDeviceSync>
  chat: ReturnType<typeof useWorkspaceChat>
  workspaceId: string
  memberAvatars: Record<string, string>
  revokingPeer: string
  blindReplication: BlindReplicationController
  myDeviceRemoval: ReturnType<typeof useMyDeviceRemoval>
  meshMembers: Mesh["meshMembers"]["value"]
  currentRole: WorkspaceRole
  succession: Mesh["activeSuccession"]["value"]
  canClaimSuccession: boolean
  canManageAccess: boolean
  transferringOwnership: string
  leavingMesh: boolean
  peerAccessError: string
  devicePresence: Mesh["devicePresence"]["value"]
  meshPresence: Mesh["meshPresence"]["value"]
  activeMeshRetryAt: Mesh["activeMeshRetryAt"]["value"]
  identityPortalOrigin: string
  addMyDevice: () => unknown
  generateWorkspaceInvite: () => unknown
  beginEnrollmentSignIn: () => unknown
  revokeWorkspacePeer: Mesh["revokeWorkspacePeer"]
  transferWorkspaceOwnership: Mesh["transferWorkspaceOwnership"]
  leaveWorkspaceMesh: Mesh["leaveWorkspaceMesh"]
  setWorkspaceSuccessor: Mesh["setWorkspaceSuccessor"]
  voteForWorkspaceSuccessor: Mesh["voteForWorkspaceSuccessor"]
  claimWorkspaceSuccession: Mesh["claimWorkspaceSuccession"]
  promoteWorkspacePeer: Mesh["promoteWorkspacePeer"]
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
