import { onBeforeUnmount, ref, watch } from "vue"
import type { useTincanban } from "../state"
import { retryPendingIdentityProfiles } from "../sync/identityDeviceActivationLoader"
import { subscribeIdentityDevicePreferences } from "../sync/identityDevicePreferenceEvents"
import type { ProfileProjectionResult } from "../sync/identityProfileProjection"

/** Projection recovery follows actual local availability, independently of a live device or Rusty connection. */
export function useIdentityProfileRecovery(app: ReturnType<typeof useTincanban>) {
  const pending = ref<ProfileProjectionResult["pending"]>([]), error = ref("")
  let disposed = false, requested = 0, completed = 0, running: Promise<void> | undefined
  const binding = () => {
    void app.docVersion.value
    const profile = app.ready.value ? app.getCurrentProfile() : null
    return profile ? JSON.stringify([profile.identity.personId, profile.identity.publicKey,
      profile.device.deviceId, profile.certificate.signature]) : ""
  }
  async function drain() {
    while (!disposed && completed < requested) {
      completed = requested
      const captured = binding(), personId = app.getCurrentProfile()?.identity.personId
      if (!captured || !personId) { pending.value = []; error.value = ""; continue }
      const current = () => !disposed && binding() === captured
      const guard = () => { if (!current()) throw new Error("Identity changed during profile recovery") }
      try {
        await app.refreshIdentity()
        guard()
        const result = await retryPendingIdentityProfiles(personId, guard)
        guard()
        pending.value = result?.pending ?? []
        error.value = ""
      } catch (cause) {
        if (current()) error.value = cause instanceof Error ? cause.message : "Private profile recovery unavailable"
      }
    }
  }
  function retry(): Promise<void> {
    if (disposed) return Promise.resolve()
    requested++
    running ??= drain().finally(() => {
      running = undefined
      if (!disposed && completed < requested) void retry()
    })
    return running
  }
  const stop = watch([binding, () => app.availableWorkspaces.value.map(workspace => workspace.id).join("|")],
    (next, previous) => {
      if (next[0] !== previous?.[0]) { pending.value = []; error.value = "" }
      if (binding()) void retry()
    }, { immediate: true })
  const stopDelivery = subscribeIdentityDevicePreferences(personId => {
    if (personId === app.getCurrentProfile()?.identity.personId) void retry()
  })
  const stopWorkspace = app.subscribeLocalChanges(() => { if (binding()) void retry() })
  onBeforeUnmount(() => { disposed = true; stop(); stopDelivery(); stopWorkspace() })
  return { pending, error, retry }
}
