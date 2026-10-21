import type { useTincanban } from "../state"
import type { PrivateReplicationState } from "./privateReplicationState"
import type { createPrivateReplicaRuntime } from "./privateReplicaLoop"
import type { ReplicationLifecycle } from "./privateReplicationActions"

export function createRustyResetAction(app: ReturnType<typeof useTincanban>, state: PrivateReplicationState,
  runtime: ReturnType<typeof createPrivateReplicaRuntime>, lifecycle: ReplicationLifecycle) {
  return async function forgetRusty(origin: string, workspaceId: string) {
    if (state.busy.value) throw new Error("Wait for current Rusty sync to finish")
    const owner = lifecycle.identity(), epoch = lifecycle.epoch(), guard = runtime.captureSession(workspaceId)
    guard()
    state.busy.value = true
    state.error.value = ""
    state.notice.value = ""
    try {
      const { forgetRustyOrigin } = await import("./rustyLocalReset")
      await forgetRustyOrigin(app, origin, workspaceId, guard)
      guard()
      runtime.clear()
      state.revokedDeviceAccess.value = state.revokedDeviceAccess.value.filter(value => !value.startsWith(`${origin}|`))
      state.profilePermissionUpdates.value = state.profilePermissionUpdates.value.filter(value => value !== origin)
      const errors = { ...state.profileSetupErrors.value }
      delete errors[origin]
      state.profileSetupErrors.value = errors
      await lifecycle.reload(owner, epoch)
      guard()
      state.notice.value = "Rusty forgotten on this device. Board data and files stay saved. Add Rusty to reconnect."
    } catch (cause) {
      state.error.value = cause instanceof Error ? cause.message : "Could not forget Rusty"
      throw cause
    } finally { state.busy.value = false }
  }
}
