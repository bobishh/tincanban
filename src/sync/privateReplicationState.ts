import { ref } from "vue"
import type { BlindReplicaConfig,IdentityReplicaConfig,PrivateReplicaConflictSummary } from "./blindReplication"
import type { ReplicaHealth } from "./replicationHealth"
import type { RegisteredDevice } from "../domain/model"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"

export function createReplicationState() {
  return {
    configs: ref<BlindReplicaConfig[]>([]), identityConfigs: ref<IdentityReplicaConfig[]>([]),
    preferenceConflicts: ref<PrivateReplicaConflictSummary[]>([]),
    profileSetupErrors: ref<Record<string, string>>({}),
    profilePermissionUpdates: ref<string[]>([]),
    registeredDevices: ref<RegisteredDevice[]>([]), pendingDeviceRevocations: ref<string[]>([]), revokedDeviceAccess: ref<string[]>([]),
    currentDeviceId: ref(""),
    statuses: ref<Record<string, ReplicaHealth>>({}), now: ref(Date.now()),
    attachmentCoverage: ref<Record<string, AttachmentCoverageStatus[]>>({}),
    busy: ref(false), error: ref(""), notice: ref(""),
  }
}

export function clearReplicationSessionState(state: ReturnType<typeof createReplicationState>) {
  state.configs.value = []
  state.identityConfigs.value = []
  state.preferenceConflicts.value = []
  state.profileSetupErrors.value = {}
  state.profilePermissionUpdates.value = []
  state.registeredDevices.value = []
  state.pendingDeviceRevocations.value = []
  state.revokedDeviceAccess.value = []
  state.currentDeviceId.value = ""
  state.statuses.value = {}
  state.attachmentCoverage.value = {}
  state.error.value = ""
  state.notice.value = ""
}

export type PrivateReplicationState = ReturnType<typeof createReplicationState>
