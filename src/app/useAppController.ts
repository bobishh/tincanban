import { onBeforeUnmount, onMounted, watch } from "vue"
import { hydratePreparedState, prepareLocalState } from "../statePersistence"
import { sendChatMessage } from "../chat/service"
import { runAppStartup, startupFailureDetail, startupFailureMessage } from "./startup"
import { useAppActions } from "./useAppActions"
import { useAppBoard, type AppBoardContext } from "./useAppBoard"
import { useAppCore } from "./useAppCore"
import { useMeshFavicon } from "../ui/useMeshFavicon"
import { useWorkspaceWindowSelection } from "./useWorkspaceWindowSelection"
import { diagnoseStartupStep } from "../sync/startupDiagnostics"

export function useAppController() {
  const core = useAppCore()
  useWorkspaceWindowSelection(() => core.tincanban.activeWorkspace.id, core)
  useMeshFavicon(core.meshPresence, core.confirmedRole)
  const board = useAppBoard(boardContext(core))
  const actions = useAppActions(core, board)
  useAppLifecycle(core, board, actions)
  return {
    workspace: core.tincanban,
    ui: appUi(core),
    board,
    actions,
    collaboration: appCollaboration(core),
  }
}

function boardContext(core: ReturnType<typeof useAppCore>): AppBoardContext {
  const {
    tincanban, sync, search, filters, isEditingBoard, itemFormParentId,
    boardRef, movedItemId, movedColumnId, onlineWorkspaceDevices, canEditItems, canEditBoard,
    notice, archiveUndo, boardRenderKey, selectedItemId, editingItemId, itemToMove,
    selectedLeadId, detailDialog, quickNoteDraft, quickNoteError,
  } = core
  return {
    tincanban, sync, search, filters, isEditingBoard, itemFormParentId,
    boardRef, movedItemId, movedColumnId, onlineWorkspaceDevices, canEditItems, canEditBoard,
    notice, archiveUndo, boardRenderKey, selectedItemId, editingItemId, itemToMove,
    selectedLeadId, detailDialog, quickNoteDraft, quickNoteError,
  }
}

function appUi(core: ReturnType<typeof useAppCore>) {
  const {
    detailDialog, importInput, showArtifactForm, search, filters, notice, archiveUndo, undoSaving,
    archiveError, historyRestoreSaving, historyRestoreError, historyRestoreNotice, isArchiveOpen,
    artifactError, showWorkspaces, showEntitySettings, isEditingBoard,
    newBoardColumnTitle, boardRef, boardRenderKey, movedItemId, movedColumnId,
    showItemForm, itemFormError, savingItem, editingColumn,
    selectedItemId, editingItemId, itemToMove, showMoveDialog, storageError, quickNoteDraft,
    quickNoteSaving, quickNoteError, hasExperimentalMcp, showMobileMenu, menuButtonRef,
    startupError, artifactDraft,
  } = core
  return { state: {
    detailDialog, importInput, showArtifactForm, search, filters, notice, archiveUndo, undoSaving,
    archiveError, historyRestoreSaving, historyRestoreError, historyRestoreNotice, isArchiveOpen,
    artifactError, showWorkspaces, showEntitySettings, isEditingBoard,
    newBoardColumnTitle, boardRef, boardRenderKey, movedItemId, movedColumnId,
    showItemForm, itemFormError, savingItem, editingColumn,
    selectedItemId, editingItemId, itemToMove, showMoveDialog, storageError, quickNoteDraft,
    quickNoteSaving, quickNoteError, hasExperimentalMcp, showMobileMenu, menuButtonRef,
    startupError, artifactDraft,
  }, controls: { toggleMobileMenu: core.toggleMobileMenu, closeMobileMenu: core.closeMobileMenu } }
}

function appCollaboration(core: ReturnType<typeof useAppCore>) {
  const {
    sync, chat, confirmedRole, currentRole, workspaceAccessErrors, workspaceRoleStatus, keeperOwnedWorkspaces, currentWorkspaceOwnerId, canEditItems, canEditBoard, canManageAccess,
    canImportWorkspace, canRenameWorkspace, devicePresence, meshPresence, meshPresenceLabel, activeMeshRetryAt,
    meshMembers, activeSuccession, canClaimSuccession,
    transferringOwnership, leavingMesh, revokingPeer, peerAccessError,
    transferWorkspaceOwnership, leaveWorkspaceMesh,
    setWorkspaceSuccessor, voteForWorkspaceSuccessor, claimWorkspaceSuccession,
    revokeWorkspacePeer, promoteWorkspacePeer,
  } = core
  return {
    device: { sync, chat, blindReplication: core.blindReplication, profileRecovery: core.profileRecovery },
    permissions: { confirmedRole, currentRole, workspaceAccessErrors, workspaceRoleStatus, keeperOwnedWorkspaces, currentWorkspaceOwnerId, canEditItems, canEditBoard, canManageAccess, canImportWorkspace, canRenameWorkspace },
    mesh: {
      devicePresence, meshPresence, meshPresenceLabel, activeMeshRetryAt, meshMembers,
      activeSuccession, canClaimSuccession, transferringOwnership, leavingMesh,
      revokingPeer, peerAccessError, transferWorkspaceOwnership,
      leaveWorkspaceMesh, setWorkspaceSuccessor, voteForWorkspaceSuccessor,
      claimWorkspaceSuccession, revokeWorkspacePeer, promoteWorkspacePeer,
    },
  }
}

function useAppLifecycle(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>, actions: ReturnType<typeof useAppActions>) {
  onMounted(async () => {
    const startup = await runAppStartup({
      loadRuntime: async () => {
        const { initializePolicyBrowserRuntime } = await import("../iroh")
        await diagnoseStartupStep("policy-wasm", initializePolicyBrowserRuntime)
        if (navigator.onLine) await diagnoseStartupStep("admission-worker-init", async () =>
          (await import("../sync/workspaceAdmissionClient")).warmWorkspaceAdmissionWorker()).catch(() => {})
      },
      prepareLocalState,
      openPairing: () => core.sync.joinFromLocation(window.location.href),
      hydrate: hydratePreparedState,
      setupLocalBoard: async () => {
        await board.setupBoardDrag()
        void registerWebMcpForApp(core, actions)
      },
      startSync: async () => {
        await core.sync.startDurableMesh()
      },
    })
    if (startup.status === "fatal") {
      core.startupError.value = {
        stage: startup.stage,
        message: startupFailureMessage(startup.stage),
        detail: startupFailureDetail(startup.error),
      }
    } else if (startup.syncError) {
      core.sync.error.value = "Sync could not start. Your local board is still available."
    }
  })
  watchBoardDrag(core, board)
  const noticeTimer = watchNotice(core)
  watchWorkspaceReset(core)
  watchVisibleColumns(core, board)
  onBeforeUnmount(() => {
    void core.sync.shutdown()
    board.destroyBoardDrag()
    board.clearHighlightTimer()
    noticeTimer.clear()
  })
}

async function registerWebMcpForApp(core: ReturnType<typeof useAppCore>, actions: ReturnType<typeof useAppActions>) {
  const { registerWebMcp } = await import("../webmcp")
  const unregister = await registerWebMcp({
    getActiveDoc: core.tincanban.getActiveDoc,
    executeCommandAsync: core.tincanban.executeCommandAsync,
    createWorkspaceAsync: actions.createAndSyncWorkspace,
    switchWorkspaceAsync: core.tincanban.switchWorkspace,
    availableWorkspaces: core.tincanban.availableWorkspaces,
    activeWorkspace: core.tincanban.activeWorkspace,
    placementIssues: core.tincanban.placementIssues,
    sendChatMessage: async body => { await sendChatMessage(core.tincanban.activeWorkspace.id, body) },
  })
  core.hasExperimentalMcp.value = Boolean(unregister)
}

function watchBoardDrag(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>) {
  watch([
    () => core.tincanban.ready.value, () => core.tincanban.activeWorkspace.id, () => core.isEditingBoard.value, () => core.canEditItems.value,
    () => core.canEditBoard.value, () => core.isArchiveOpen.value, () => core.boardRenderKey.value,
    () => board.visibleColumns.value.map(column => `${column.id}:${board.itemsForColumn(column).map(item => item.id).join(",")}`).join("|"),
  ], () => { void board.setupBoardDrag() }, { flush: "post" })
}

function watchNotice(core: ReturnType<typeof useAppCore>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(core.notice, message => {
    if (timer) clearTimeout(timer)
    const hasUndo = core.archiveUndo.value && (message === "Item archived" || message.startsWith("Restore failed"))
    if (message && !hasUndo) timer = setTimeout(() => { core.notice.value = "" }, 4_000)
  })
  return { clear: () => { if (timer) clearTimeout(timer) } }
}

function watchWorkspaceReset(core: ReturnType<typeof useAppCore>) {
  watch(() => core.tincanban.activeWorkspace.id, () => {
    core.isEditingBoard.value = false
    core.editingColumn.value = null
    core.showEntitySettings.value = false
    core.showItemForm.value = false
    core.filters.value = { columnId: "", fieldValues: {}, numberRanges: {}, dateRanges: {} }
    core.search.value = ""
    core.archiveUndo.value = null
    core.archiveError.value = ""
    core.historyRestoreError.value = ""
    core.historyRestoreNotice.value = ""
  })
}

function watchVisibleColumns(core: ReturnType<typeof useAppCore>, board: ReturnType<typeof useAppBoard>) {
  watch(() => board.visibleColumns.value.map(column => column.id).join("|"), () => {
    board.resetBoardScroll()
  }, { flush: "post" })
}
