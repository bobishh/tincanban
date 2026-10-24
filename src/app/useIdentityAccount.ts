import { computed, ref, watch, type Ref } from "vue"
import type { useAppController } from "./useAppController"
import { configuredIdentityPortalOrigin } from "./identityPortalConfig"
import { identityEnrollmentConfirmed } from "./identityEnrollmentReceipt"
import { createIdentityPortalFlow } from "./identityPortalFlow"
import { createIdentityBrowserSignInReturn } from "./identityBrowserSignIn"

/** Keep account presentation and the Identity return flow on the same durable profile. */
export function useIdentityAccount(app: ReturnType<typeof useAppController>, showSettings: Ref<boolean>) {
  const showIdentityPortal = ref(false), identityPortalOrigin = configuredIdentityPortalOrigin(import.meta.env.VITE_IDENTITY_ORIGIN as string | undefined)
  const currentIdentityProfile = computed(() => { void app.workspace.docVersion.value; return app.workspace.getCurrentProfile() })
  const identitySignedIn = ref(false), identityPortalMode = ref<"choose" | "signin" | "connect">("choose")
  watch(currentIdentityProfile, async profile => {
    const connected = Boolean(profile && await identityEnrollmentConfirmed(profile))
    if (currentIdentityProfile.value === profile) identitySignedIn.value = connected
  }, { immediate: true })
  function beginHeaderSignIn() {
    identityPortalMode.value = "signin"
    showSettings.value = false
    showIdentityPortal.value = true
  }
  function beginDeviceConnection() {
    identityPortalMode.value = "connect"
    showSettings.value = false
    showIdentityPortal.value = true
  }
  const identityPortalFlow = createIdentityPortalFlow({ configured: Boolean(identityPortalOrigin), showPortal: showIdentityPortal, getProfile: app.workspace.getCurrentProfile, refreshIdentity: app.workspace.refreshIdentity })
  const browserSignInReturn = createIdentityBrowserSignInReturn({ showPortal: showIdentityPortal,
    refreshIdentity: app.workspace.refreshIdentity, closePortal: identityPortalFlow.close,
    resumeRustyConnection: async (origin, workspaceId) => {
      await app.workspace.whenReady()
      await app.collaboration.device.blindReplication.attachAfterIdentityApproval(origin, workspaceId)
    },
    reportRustyConnectionFailure: (origin, cause) => {
      app.ui.state.notice.value = `Identity linked ${origin}, but Rusty setup is pending. Retry Add Rusty to finish. ${cause instanceof Error ? cause.message : ""}`.trim()
    } })
  return { showIdentityPortal, identityPortalOrigin, currentIdentityProfile, identitySignedIn, identityPortalMode,
    beginHeaderSignIn, beginDeviceConnection, identityPortalFlow, browserSignInReturn }
}
