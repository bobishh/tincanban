import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue"
import type { useAppController } from "./useAppController"
import { createLazySyncDialog } from "./syncDialogStatus"

export function useAppViewState(app: ReturnType<typeof useAppController>, routeContent?: Ref<HTMLElement | null>) {
  const { activeWorkspace, ready, startupStage, docVersion, getActiveDoc } = app.workspace
  const { sync } = app.collaboration.device
  const { confirmedRole, workspaceRoleStatus } = app.collaboration.permissions
  const boardPainted = ref(false)
  let cancelled = false
  let revealTimer: ReturnType<typeof setTimeout> | undefined
  onBeforeUnmount(() => { cancelled = true; clearTimeout(revealTimer) })
  watch(() => app.ui.state.boardRef.value ?? routeContent?.value, content => {
    if (!content || boardPainted.value) return
    const reveal = () => {
      clearTimeout(revealTimer)
      if (!cancelled) boardPainted.value = true
    }
    // Prefer a complete paint cycle; suspended frames must not trap the cover.
    revealTimer = setTimeout(reveal, 250)
    requestAnimationFrame(() => requestAnimationFrame(reveal))
  }, { flush: "post" })
  return {
    stopSyncForIdentityRestore: () => sync.shutdown(),
    restoredIdentity: () => window.location.reload(),
    historyNames: computed(() => {
      const names = Object.fromEntries(app.collaboration.device.chat.members.value.map(member => [member.personId, member.name]))
      const identity = app.workspace.getCurrentProfile()?.identity
      if (identity) names[identity.personId] = identity.displayName
      return names
    }),
    startupCoverVisible: computed(() => !boardPainted.value && !app.ui.state.startupError.value),
    SyncDialog: createLazySyncDialog(sync.dismiss),
    reviewCausalChange: (hash: string) => app.workspace.reviewCausalChange(hash),
    dismissCausalChange: (hash: string) => app.workspace.dismissCausalChange(hash),
    restoreCausalChange: (hash: string) => app.workspace.restoreCausalChange(hash),
    chatCanView: computed(() => confirmedRole.value !== null && !sync.isWorkspaceAccessRevoked(activeWorkspace.id)),
    uiReady: computed(() => ready.value && workspaceRoleStatus.value !== "loading"),
    boardVisible: computed(() => { void docVersion.value; return Boolean(getActiveDoc() && activeWorkspace.id) }),
    startupMessage: computed(() => ({
      starting: "Starting local checks…", reading: "Reading saved board…", updating: "Updating saved board…",
      history: "Checking saved changes…", access: "Checking workspace access…",
    })[startupStage.value]),
  }
}
