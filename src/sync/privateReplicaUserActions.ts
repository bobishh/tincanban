import { ref } from "vue"
import type { createPrivateReplicationActions } from "./privateReplicationActions"

/** Reserve one user request without disabling controls for background I/O. */
export function createPrivateReplicaUserActions(waitForBackground: () => Promise<unknown>, captureSession: () => () => void) {
  const busy = ref(false)
  function manual<Args extends unknown[], Result>(operation: (...args: Args) => Promise<Result>) {
    return async (...args: Args): Promise<Result> => {
      if (busy.value) throw new Error("Another Rusty action is already pending")
      const guard = captureSession()
      guard()
      busy.value = true
      try {
        await waitForBackground()
        guard()
        return await operation(...args)
      } finally { busy.value = false }
    }
  }
  function protect(actions: ReturnType<typeof createPrivateReplicationActions>) {
    return {
      attach: manual(actions.attach), resumeRustyOperation: manual(actions.resumeRustyOperation), forgetRusty: manual(actions.forgetRusty),
      updateDeviceAccess: manual(actions.updateDeviceAccess), revokeIdentityDevice: manual(actions.revokeIdentityDevice),
      recoverCredentialConflict: manual(actions.recoverCredentialConflict), compactWorkspaceHistory: manual(actions.compactWorkspaceHistory),
      remove: manual(actions.remove),
    }
  }
  return { busy, protect }
}
