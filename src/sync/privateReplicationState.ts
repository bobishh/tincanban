import { ref } from "vue"
import type { BlindReplicaConfig,IdentityReplicaConfig,PrivateReplicaConflictSummary } from "./blindReplication"
import type { ReplicaHealth } from "./replicationHealth"
import type { RegisteredDevice } from "../domain/model"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"
import type { PendingRustyOperation } from "./pendingRustyOperation"

export function createReplicationState() {
  return {
    configs: ref<BlindReplicaConfig[]>([]), identityConfigs: ref<IdentityReplicaConfig[]>([]),
    preferenceConflicts: ref<PrivateReplicaConflictSummary[]>([]),
    profileSetupErrors: ref<Record<string, string>>({}),
    profilePermissionUpdates: ref<string[]>([]),
    registeredDevices: ref<RegisteredDevice[]>([]), pendingDeviceRevocations: ref<string[]>([]), revokedDeviceAccess: ref<string[]>([]),
    currentDeviceId: ref(""),
    pendingRustyOperations: ref<PendingRustyOperation[]>([]),
    deviceSyncIssues: ref<Record<string, string>>({}),
    statuses: ref<Record<string, ReplicaHealth>>({}), now: ref(Date.now()),
    attachmentCoverage: ref<Record<string, AttachmentCoverageStatus[]>>({}),
    busy: ref(false), error: ref(""), notice: ref(""), historyNotices: ref<Record<string, string>>({}),
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
  state.pendingRustyOperations.value = []
  state.statuses.value = {}
  state.deviceSyncIssues.value = {}
  state.attachmentCoverage.value = {}
  state.error.value = ""
  state.notice.value = ""
  state.historyNotices.value = {}
}

export type PrivateReplicationState = ReturnType<typeof createReplicationState>

/** Unexpected local failures belong to device sync, independently of any server. */
export function reportDeviceSyncProblem(state: PrivateReplicationState, cause: unknown): void {
  state.error.value = "Sync paused on this device. Your saved changes are retained. Retry sync."
  state.deviceSyncIssues.value = { ...state.deviceSyncIssues.value, session: state.error.value }
  void import("./meshTrace").then(({ meshTrace }) => meshTrace("replication.device.failed", {}, "warn", cause)).catch(() => {})
}
