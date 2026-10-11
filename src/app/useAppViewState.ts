import { computed, onBeforeUnmount, ref, watch } from "vue"
import type { useAppController } from "./useAppController"
import { createLazySyncDialog } from "./syncDialogStatus"

export function useAppViewState(app: ReturnType<typeof useAppController>) {
  const { activeWorkspace, ready, startupStage, docVersion, getActiveDoc } = app.workspace
  const { sync } = app.collaboration.device
  const { confirmedRole, workspaceRoleStatus } = app.collaboration.permissions
  const boardPainted = ref(false)
  let cancelled = false
  onBeforeUnmount(() => { cancelled = true })
  watch(app.ui.state.boardRef, board => {
    if (!board || boardPainted.value) return
    // Vue has committed the board; give the browser a complete layout/paint cycle.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!cancelled) boardPainted.value = true
    }))
  }, { flush: "post" })
  return {
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
