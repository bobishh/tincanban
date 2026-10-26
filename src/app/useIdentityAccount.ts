import { computed, nextTick, ref, watch, type Ref } from "vue"
import type { useAppController } from "./useAppController"
import { configuredIdentityPortalOrigin } from "./identityPortalConfig"
import { identityEnrollmentConfirmed } from "./identityEnrollmentReceipt"
import { createIdentityPortalFlow } from "./identityPortalFlow"
import { createIdentityBrowserSignInReturn } from "./identityBrowserSignIn"
import { resolveIdentitySignInReturnPath } from "./boardRoute"

/** Keep account presentation and the Identity return flow on the same durable profile. */
export function useIdentityAccount(app: ReturnType<typeof useAppController>, showSettings: Ref<boolean>) {
  const showIdentityPortal = ref(false), identityPortalOrigin = configuredIdentityPortalOrigin(import.meta.env.VITE_IDENTITY_ORIGIN as string | undefined)
  const currentIdentityProfile = computed(() => { void app.workspace.docVersion.value; return app.workspace.getCurrentProfile() })
  const identitySignedIn = ref(false), identityPortalMode = ref<"choose" | "signin">("choose")
  watch(currentIdentityProfile, async profile => {
    const connected = Boolean(profile && await identityEnrollmentConfirmed(profile))
    if (currentIdentityProfile.value === profile) identitySignedIn.value = connected
  }, { immediate: true })
  function beginHeaderSignIn() {
    identityPortalMode.value = "signin"
    showSettings.value = false
    showIdentityPortal.value = true
  }
  async function beginDeviceEnrollment(start: () => Promise<void>) {
    showSettings.value = false
    const sync = app.collaboration.device.sync
    sync.open()
    await nextTick()
    if (!sync.isOpen.value || !["chooser", "members"].includes(sync.step.value)) return
    try { await start() }
    catch (cause) {
      app.ui.state.notice.value = cause instanceof Error ? cause.message : "Could not start device enrollment."
    }
  }
  const identityPortalFlow = createIdentityPortalFlow({ configured: Boolean(identityPortalOrigin), showPortal: showIdentityPortal, getProfile: app.workspace.getCurrentProfile, refreshIdentity: app.workspace.refreshIdentity })
  const browserSignInReturn = createIdentityBrowserSignInReturn({ showPortal: showIdentityPortal,
    refreshIdentity: app.workspace.refreshIdentity, closePortal: identityPortalFlow.close,
    loadBoards: async returnPath => {
      const loader = await import("./identityBoardLoading")
      try { await loader.resumeIdentityBoardLoading(app.workspace, returnPath) }
      catch (cause) {
        if (cause instanceof loader.IdentityCatalogApprovalRequired) return "approval_required"
        throw cause
      }
    },
    resolveReturnPath: path => resolveIdentitySignInReturnPath(path, app.workspace.activeBoard.value),
    resumeRustyConnection: async (origin, workspaceId) => {
      await app.workspace.whenReady()
      await app.collaboration.device.blindReplication.attachAfterIdentityApproval(origin, workspaceId)
    },
    reportRustyConnectionFailure: (origin, cause) => {
      app.ui.state.notice.value = `Identity linked ${origin}, but Rusty setup is pending. Retry Add Rusty to finish. ${cause instanceof Error ? cause.message : ""}`.trim()
    } })
  watch(() => [app.workspace.ready.value, currentIdentityProfile.value?.identity.personId, browserSignInReturn.returning.value],
    async ([ready, , returning]) => {
      const profile = currentIdentityProfile.value
      if (!ready || returning || !profile || browserSignInReturn.boardLoading.value) return
      const loader = await import("./identityBoardLoading")
      if (await loader.hasPendingIdentityBoardLoading(profile) && currentIdentityProfile.value === profile &&
          !browserSignInReturn.returning.value && !browserSignInReturn.boardLoading.value) void browserSignInReturn.retryBoards()
    }, { immediate: true })
  function retryIdentityBoards() {
    if (browserSignInReturn.boardCatalogApprovalRequired.value) beginHeaderSignIn()
    else void browserSignInReturn.retryBoards()
  }
  return { showIdentityPortal, identityPortalOrigin, currentIdentityProfile, identitySignedIn, identityPortalMode,
    beginHeaderSignIn, beginDeviceEnrollment, identityPortalFlow, browserSignInReturn, retryIdentityBoards }
}
