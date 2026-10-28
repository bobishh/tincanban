<!-- Workspace role gates are enforced again at command and sync boundaries. -->
<script setup lang="ts">
import { recordUsageAction } from "./usageActions"
import { useAppController } from "./app/useAppController"
import { useAppItemDocumentSave } from "./app/useAppItemDocumentSave"
import { isArchiveColumn, isItemArchived } from "./domain/archive"
import { cardStageButtons } from "./domain/cardStageButtons"
import { useCardAges } from "./app/useAgingClock"
import { showEnteringElement, hideLeavingElement } from "./ui/modal"
import DialogWindow from "./components/DialogWindow.vue"
import TincanbanPageLayout from "./components/TincanbanPageLayout.vue"
import TincanbanHeading from "./components/TincanbanHeading.vue"
import BrandCan from "./components/BrandCan.vue"
import BoardDragOverlay from "./components/BoardDragOverlay.vue"
import BoardSurface from "./components/BoardSurface.vue"
import BoardToolbar from "./components/BoardToolbar.vue"
import { useObjectConversations } from "./app/useObjectConversations"
import SaveState from "./components/SaveState.vue"
import StartupStatus from "./components/StartupStatus.vue"
import { LazyItemDocuments as ItemDocuments } from "./app/lazyItemDocuments"
import { ItemFormDialog } from "./app/lazyItemFormDialog"
import BuildFooter from "./components/BuildFooter.vue"
import ReleaseUpgradeNotice from "./components/ReleaseUpgradeNotice.vue"
import ConnectedIdentityProfile from "./components/ConnectedIdentityProfile.vue"
import IdentityAccountControls from "./components/IdentityAccountControls.vue"
import { useIdentityAccount } from "./app/useIdentityAccount"
import { useAutomationConnection } from "./app/useAutomationConnection"
import type { saveIdentityName as identityNameSaverType } from "./app/identityName"
import { computed, defineAsyncComponent, onBeforeUnmount, ref, type Component, watch } from "vue"
import type { NarrativeFoldSources } from "./domain/commandTypes"
import { useColumnCollapse } from "./ui/useColumnCollapse"
import { useAppViewState } from "./app/useAppViewState"
import { useBoardAddress } from "./app/useBoardAddress"
import { useMemberAvatars } from "./app/useMemberAvatars"
import { useAppPublicBoards } from "./app/useAppPublicBoards"
import { createIdentityOwnerActions } from "./app/identityOwnerActions"
import { createWorkspaceInviteAction } from "./app/identityPortalFlow"
import { CausalChangeReview, ColumnDialog, IdentityBoardLoadingNotice, IdentitySettingsPanel, ItemDetailDialog, MobileDrawer, MoveItemDialog, ObjectConversationLayer, PublicBoardApp, SchemaEditorDialog, startOfflineDetailPreload, WorkspaceSettingsPanel, WorkspacesDialog } from "./app/lazyUiComponents"

const app = useAppController()
const AutomationConnectionDialog = defineAsyncComponent<Component>(() => import("./components/AutomationConnectionDialog.vue") as Promise<{ default: Component }>)
const RustyStatusDialog = defineAsyncComponent<Component>(() => import("./components/RustyStatusDialog.vue"))
const showRustyStatus = ref(new URLSearchParams(window.location.hash.slice(1)).has("rusty-status"))
const boardAddress = useBoardAddress(app.workspace)
const routeContent = ref<HTMLElement | null>(null)
type IdentityNameSaver = typeof identityNameSaverType
const saveIdentityName: IdentityNameSaver = async (...args) => (await import("./app/identityName")).saveIdentityName(...args)
const WorkspaceFileActions = defineAsyncComponent<Component>(() => import("./components/WorkspaceFileActions.vue"))
const WorkspacePrivateRecoveryPanel = defineAsyncComponent<Component>(() => import("./components/WorkspacePrivateRecoveryPanel.vue"))
const WorkspaceHistoryMaintenance = defineAsyncComponent<Component>(() => import("./components/WorkspaceHistoryMaintenance.vue"))
const IdentityPortalEnrollmentDialog = defineAsyncComponent<Component>(() => import("./components/IdentityPortalEnrollmentDialog.vue"))
const PublicBoardControls = defineAsyncComponent(() => import("./components/PublicBoardControls.vue") as Promise<{ default: Component }>)
const { historyNames, SyncDialog, reviewCausalChange, dismissCausalChange, restoreCausalChange, chatCanView, uiReady, boardVisible: workspaceBoardVisible, startupMessage, startupCoverVisible } = useAppViewState(app, routeContent)
const boardAddressResolved = computed(() => boardAddress.status.value !== "resolving" && boardAddress.status.value !== "unavailable")
const boardVisible = computed(() => workspaceBoardVisible.value && boardAddressResolved.value)
const conversations = useObjectConversations(app)
const showSettings = ref(false)
const { showIdentityPortal, identityPortalOrigin, currentIdentityProfile, identitySignedIn, identityPortalMode,
  beginHeaderSignIn, beginDeviceEnrollment, identityPortalFlow, browserSignInReturn, retryIdentityBoards } = useIdentityAccount(app, showSettings)
const { connectingAutomation, describeAutomationBoard, exportAutomationConnection } = useAutomationConnection(app.workspace, browserSignInReturn.returning)
const workspaceDialogBusy = ref(false)
function openConnections() {
  showSettings.value = false
  sync.open()
}
const editingFoldSnapshot = ref<NarrativeFoldSources | undefined>()
const { workspace, ready, saveState, availableWorkspaces, archivedWorkspaces, causalReview, causalReviewError, activeWorkspace, activeBoard, genericColumns, boardFields, getActiveDoc, documentsFor } = app.workspace
onBeforeUnmount(startOfflineDetailPreload(() => ready.value))
const { state: ui, controls: uiControls } = app.ui
const { isCollapsed: isColumnCollapsed, toggle: toggleColumnCollapse } = useColumnCollapse(() => activeWorkspace.id, () => hasFilters.value)
const {
  importInput, search, filters,
  notice, archiveUndo, undoSaving, archiveError, historyRestoreSaving,
  historyRestoreError, historyRestoreNotice,
  showWorkspaces, showEntitySettings, isEditingBoard,
  newBoardColumnTitle, boardRef, boardRenderKey, movedItemId, movedColumnId,
  showItemForm, itemFormError, savingItem, editingColumn,
  selectedItemId, editingItemId, itemToMove, showMoveDialog, storageError,
  quickNoteDraft, quickNoteSaving, quickNoteError, hasExperimentalMcp,
  showMobileMenu, menuButtonRef, startupError,
} = ui
const mobileDrawerRequested = ref(false)
watch(showMobileMenu, open => { if (open) mobileDrawerRequested.value = true })
const { toggleMobileMenu, closeMobileMenu } = uiControls
const {
  workspaceLabel, entityName, addItemLabel, itemFormColumns, itemFormParentValue,
  computedItemFieldIds, visibleItems, hasFilters, workspacePresenceSummary,
  visibleColumns, clearFilters, cardNotes, cardFields, cardSummaryFields, cardNoteSearchMatch, expandFilteredCards, columnColor, columnStatus, itemsForColumn,
  trackBoardScroll, selectedItem, subitemsForSelectedItem,
  selectedItemHistory, editingItem, candidateParentsForMove, archivedHistoryLoading, archivedHistoryError,
  archivedHistoryNotice, archivedHistoryHasMore, loadEarlierItemHistory,
} = app.board
const { sync, chat } = app.collaboration.device
const generateWorkspaceInviteWithIdentity = createWorkspaceInviteAction({ gate: identityPortalFlow.gate, getWorkspaceId: () => activeWorkspace.id, sync })
const showConversationLayer = computed(() => chat.open.value || conversations.currentDiscussions.value.length > 0 || Boolean(
  conversations.selection.value || conversations.contextMenu.value || conversations.sourceState.value || conversations.navigationState.value,
))
const { confirmedRole, currentRole, workspaceAccessErrors, workspaceRoleStatus, canEditItems, canEditBoard, canManageAccess, canRenameWorkspace } = app.collaboration.permissions
const { devicePresence, meshPresence, meshPresenceLabel,
  activeMeshRetryAt, meshMembers, activeSuccession,
  canClaimSuccession, transferringOwnership, leavingMesh, revokingPeer,
  peerAccessError, transferWorkspaceOwnership,
  leaveWorkspaceMesh, setWorkspaceSuccessor, voteForWorkspaceSuccessor,
  claimWorkspaceSuccession, revokeWorkspacePeer, promoteWorkspacePeer,
} = app.collaboration.mesh
const {
  openBoardItem,
  restoreSelectedItemVersion, saveQuickNote, updateDocumentMarkdown, updateItemMarkdown, handleSaveTemplate,
  moveCardToColumn,
  myDeviceRemoval, exportWorkspace, exportAllWorkspaces, createPrivateRecovery, privateRecoveryUnavailableReason, inspectPrivateRecovery, restorePrivateRecovery, hasWorkspaceCopy, workspaceTitle,
  openImport, importWorkspace, workspaceImportState, handleCreateWorkspace,
  handleSwitchWorkspace, handleRenameWorkspace, handleArchiveWorkspace, handleRestoreWorkspace, openAddItem,
  handleSaveItem, currentDocHeads, handleApplySchema, handleApplyWorkspaceSettings, settingsSaveError, settingsSaving,
  handleArchiveItem, handleRestoreItem, undoArchive, handleOpenItemEdit, handleAddSubitem,
  handleStartMove, handleConfirmMove, handleRenameColumn, handleArchiveColumn, addBoardColumn, newBoardColumnArchive, newBoardColumnCollapsible, addingBoardColumn, addBoardColumnError, selectArchiveColumn,
} = app.actions
const { publicAccess, publicDelivery } = useAppPublicBoards(app, uiReady)
const identityOwnerActions = createIdentityOwnerActions({ gate: identityPortalFlow.gate, portalOrigin: identityPortalOrigin, publicAccess,
  getProfile: app.workspace.getCurrentProfile, getBoard: () => ({ boardId: activeBoard.value?.id ?? "", workspaceId: activeWorkspace.id, sourceHeads: [...currentDocHeads.value] }),
  isOwner: () => confirmedRole.value === "owner", addMyDevice: sync.selectSyncAll, isSyncChooserOpen: () => sync.isOpen.value && (sync.step.value === "chooser" || sync.step.value === "members") })
function beginIdentityDeviceEnrollment() { return beginDeviceEnrollment(identityOwnerActions.addMyDevice) }
const publicAccessWithIdentity = { ...publicAccess, setPublic: identityOwnerActions.setPublic }
function openCard(item: Parameters<typeof openBoardItem>[0], event: MouseEvent) { conversations.openCard(item, event); recordUsageAction("item_open") }
function toggleCardTask(item: Parameters<typeof openBoardItem>[0], markdown: string) { void updateItemMarkdown(item, markdown) }
async function switchWorkspaceFromDirectory(workspaceId: string) { await handleSwitchWorkspace(workspaceId); boardAddress.navigateToActiveBoard() }
const { saveSelectedItemDocument } = useAppItemDocumentSave(app)
async function editItem(item: Parameters<typeof openBoardItem>[0]) {
  const { createNarrativeEditHandler } = await import("./app/narrativeEditor")
  createNarrativeEditHandler(editingFoldSnapshot, activeBoard, () => getActiveDoc()?.entities ?? {}, handleOpenItemEdit)(item)
}
async function applyWorkspaceSettings(payload: Parameters<typeof handleApplyWorkspaceSettings>[0]) { if (await handleApplyWorkspaceSettings(payload)) showSettings.value = false }
const cardAgeFor = useCardAges(() => activeBoard.value?.cardAgingPolicy)
function setBoardElement(element: HTMLElement | null) { boardRef.value = element }
function boardCardPresentation(item: Parameters<typeof cardNotes>[0], column: Parameters<typeof cardAgeFor>[1]) {
  const match = cardNoteSearchMatch(item)
  const age = cardAgeFor(item, column)
  return { notes: cardNotes(item), fields: cardFields(item), summaryFields: cardSummaryFields(item),
    hasFilters: expandFilteredCards.value || Boolean(match), showFields: hasFilters.value,
    searchQuery: match?.query, searchMatchIndex: match?.index,
    discussion: conversations.cardDiscussions.value.get(item.id), moved: movedItemId.value === item.id,
    ageLevel: age?.level, ageLabel: age?.label }
}
const { memberAvatars, currentAvatar, saveAvatar, avatarNotice, profileLoadError, retryProfileLoad, profileConflicts, profileRevision, identityNameProvided } = useMemberAvatars(app.workspace, browserSignInReturn.contextReady)
function saveProfile(draft: { name?: string; avatarData?: string | null; revision?: string }) {
  if (draft.name !== undefined) return saveIdentityName(draft.name, activeWorkspace.id, app.workspace.refreshIdentity, { avatarData: draft.avatarData, expectedRevision: draft.revision })
  if (draft.avatarData !== undefined) return saveAvatar(draft.avatarData, draft.revision)
  return Promise.resolve()
}
</script>

<template>
  <ReleaseUpgradeNotice />
  <Transition name="startup-cover" @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
    <StartupStatus v-if="startupCoverVisible" expanded :message="startupMessage" :view-only="false" :error="null" />
  </Transition>
  <div v-if="boardAddress.publicFallback.value" v-show="boardAddress.publicReadable.value">
    <PublicBoardApp v-bind="boardAddress.publicFallback.value" @availability="boardAddress.setPublicAvailability" />
  </div>
  <TincanbanPageLayout v-if="!boardAddress.publicReadable.value" :class="{ 'startup-concealed': startupCoverVisible, 'startup-revealed': !startupCoverVisible }" :inert="startupCoverVisible || workspaceDialogBusy || boardAddress.publicReadPending.value || undefined" :busy="!uiReady && !startupError || boardAddress.publicReadPending.value">
    <template #header>
      <button class="brand brand-button" type="button" aria-label="Open workspaces" :disabled="!uiReady" @click="showWorkspaces = true">
        <span class="brand-presence">
          <span v-if="ready.value && workspaceRoleStatus === 'unavailable'" class="sr-only" role="img" aria-label="Workspace permissions: unavailable" />
          <BrandCan :presence="meshPresence" :label="uiReady ? meshPresenceLabel : 'Workspace access is not yet confirmed'" :access-role="confirmedRole" />
        </span>
        <div>
          <TincanbanHeading :label="boardVisible ? workspaceLabel : '…'" />
        </div>
      </button>
      <div class="topbar-mobile-controls">
        <button class="button button-quiet button-small" type="button" aria-label="Workspace chat" :disabled="!uiReady || !boardAddressResolved" @click="chat.open.value = true">Chat<span v-if="chat.unread.value"> · {{ chat.unread.value }}</span></button>
        <button
          ref="menuButtonRef"
          class="button button-quiet mobile-menu-button"
          type="button"
          aria-label="Menu"
          :disabled="!uiReady"
          :aria-expanded="showMobileMenu ? 'true' : 'false'"
          aria-controls="mobile-drawer"
          @click="toggleMobileMenu"
        >
          <span class="hamburger-icon" aria-hidden="true">☰</span>
        </button>
      </div>
      <div class="top-actions top-actions-desktop" :inert="!uiReady || undefined">
        <button class="button button-quiet" type="button" aria-label="Workspace chat" :disabled="!boardAddressResolved" @click="chat.open.value = true">Chat<span v-if="chat.unread.value"> · {{ chat.unread.value }}</span></button>
        <button class="button button-quiet" type="button" @click="openConnections()">Sync</button>
        <IdentityAccountControls :portal-enabled="Boolean(identityPortalOrigin)" :signed-in="identitySignedIn" :person-id="currentIdentityProfile?.identity.personId" @sign-in="beginHeaderSignIn" @settings="showSettings = true" />
        <button v-if="canEditBoard" class="button button-quiet" type="button" :disabled="!boardAddressResolved" @click="isEditingBoard = !isEditingBoard">{{ isEditingBoard ? "Done" : "Edit board" }}</button>
        <button v-if="isEditingBoard" class="button button-primary" type="button" :disabled="!boardAddressResolved" @click="showEntitySettings = true">Edit {{ entityName }}</button>
        <a v-if="hasExperimentalMcp" class="button button-quiet agent-guide-desktop" href="/agent">Agent guide</a>
        <input ref="importInput" class="sr-only" type="file" accept=".tincanban,.match,application/vnd.tincanban+zip,application/vnd.match+zip" @change="importWorkspace" />
      </div>
    </template>

    <section v-if="boardAddress.status.value === 'unavailable' && !boardAddress.publicReadPending.value" ref="routeContent" class="board-address-unavailable" role="alert">
      <h1>Board unavailable</h1>
      <p>This board is not available to the current identity on this device.</p>
      <button class="button button-small" type="button" @click="boardAddress.retry">Try again</button>
      <a class="button button-small" href="/">Open local boards</a>
    </section>
    <p v-else-if="boardAddress.status.value === 'resolving' || boardAddress.publicReadPending.value" ref="routeContent" class="board-address-progress" role="status">Opening board…</p>

    <CausalChangeReview v-if="boardVisible && (causalReview.length || causalReviewError)" :changes="causalReview" :error="causalReviewError"
      :can-review="uiReady && canEditItems" :review-change="reviewCausalChange"
      :dismiss-change="dismissCausalChange" :restore-change="restoreCausalChange" />

    <BoardToolbar v-if="boardVisible" v-model:search="search" v-model:filters="filters" :columns="genericColumns" :fields="boardFields"
      :placeholder="'Search cards'" :inert="!boardVisible || undefined">
      <SaveState :state="saveState" :settled-label="workspacePresenceSummary" aria-label="Workspace presence" />
    </BoardToolbar>

    <Transition name="startup-cover" @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
      <StartupStatus v-if="!startupCoverVisible && (!uiReady || startupError)" :message="startupMessage" :view-only="boardVisible" :error="startupError" />
    </Transition>

    <MobileDrawer
      v-if="mobileDrawerRequested"
      :is-open="showMobileMenu"
      :active-workspace-title="workspaceLabel"
      :is-editing-board="isEditingBoard && boardAddressResolved"
      :can-edit-board="canEditBoard && boardAddressResolved"
      :entity-name="entityName" :show-sign-in="Boolean(identityPortalOrigin) && !identitySignedIn" :sign-in-ready="Boolean(currentIdentityProfile)"
      @close="closeMobileMenu"
      @open-workspaces="showWorkspaces = true"
      @open-settings="showSettings = true" @sign-in="beginHeaderSignIn"
      @toggle-board-edit="isEditingBoard = !isEditingBoard"
      @open-entity-settings="showEntitySettings = true"
      @open-sync="openConnections()"
    />

    <WorkspacesDialog
      v-if="showWorkspaces"
      :workspaces="availableWorkspaces" :archived-workspaces="archivedWorkspaces"
      :active-workspace-id="activeWorkspace.id"
      :importing="workspaceImportState.busy" :import-error="workspaceImportState.error"
      :read-owner="async (id: string) => (await app.workspace.readWorkspaceDoc(id)).ownerPersonId"
      :current-person-id="currentIdentityProfile?.identity.personId ?? ''" :current-identity-name="currentIdentityProfile?.identity.displayName ?? ''" :known-people="chat.members.value"
      :rename-workspace="handleRenameWorkspace" :archive-workspace="handleArchiveWorkspace" :restore-workspace="handleRestoreWorkspace"
      :create-workspace="handleCreateWorkspace"
      :can-rename-workspace="canRenameWorkspace"
      @close="showWorkspaces = false"
      @switch="switchWorkspaceFromDirectory"
      @import="openImport"
      @busy="workspaceDialogBusy = $event"
    />

    <SchemaEditorDialog
      v-if="showSettings && activeBoard && getActiveDoc()"
      :workspace-id="activeWorkspace.id"
      :doc="getActiveDoc()!"
      :read-only="!canEditBoard"
      :board="activeBoard"
      :columns="genericColumns"
      :fields="boardFields"
      :templates="workspace.templates"
      :heads="currentDocHeads"
      :save-error="settingsSaveError"
      :saving="settingsSaving"
      mode="templates"
      @close="showSettings = false; settingsSaveError = ''"
      :save-template="handleSaveTemplate"
      @apply-workspace-settings="applyWorkspaceSettings"
    >
      <template #identity>
        <ConnectedIdentityProfile v-if="identityPortalOrigin && identitySignedIn && currentIdentityProfile" :name="currentIdentityProfile.identity.displayName" :person-id="currentIdentityProfile.identity.personId" :avatar-data="currentAvatar" :portal-origin="identityPortalOrigin" @refresh="beginHeaderSignIn" @connect="beginIdentityDeviceEnrollment" />
        <IdentitySettingsPanel v-else :connect-device="identityPortalOrigin ? beginIdentityDeviceEnrollment : undefined" :workspace-id="activeWorkspace.id" :display-name="app.workspace.getCurrentProfile()?.identity.displayName ?? ''" :avatar-data="currentAvatar" :save-avatar="saveAvatar" :save-name="(name: string) => saveIdentityName(name, activeWorkspace.id, app.workspace.refreshIdentity)"
          :name-provided="identityNameProvided" :name-options="profileConflicts.names" :photo-options="profileConflicts.photos" :profile-revision="profileRevision || undefined" :profile-load-error="profileLoadError" :retry-profile-load="retryProfileLoad" :save-profile="saveProfile">
          <WorkspacePrivateRecoveryPanel :selected-workspace-title="activeWorkspace.title" :create-backup="createPrivateRecovery" :create-unavailable-reason="privateRecoveryUnavailableReason"
            :inspect-file="inspectPrivateRecovery" :restore="restorePrivateRecovery" :has-workspace-copy="hasWorkspaceCopy"
            :workspace-title="workspaceTitle" :current-person-id="chat.personId.value" />
        </IdentitySettingsPanel>
        <p v-if="avatarNotice" role="status">{{ avatarNotice }}</p>
      </template>
      <template #workspace>
        <WorkspaceSettingsPanel :presence="meshPresenceLabel" :save-state="saveState" :diagnostic="sync.meshDiagnostic.value">
          <WorkspaceFileActions :export-workspace="exportWorkspace" :export-all-workspaces="exportAllWorkspaces" :import-workspace="openImport" :import-busy="workspaceImportState.busy" :import-error="workspaceImportState.error" />
          <WorkspaceHistoryMaintenance :controller="app.collaboration.device.blindReplication" :workspace-id="activeWorkspace.id" :owner="currentRole === 'owner'" />
          <PublicBoardControls v-if="uiReady" :access="publicAccessWithIdentity" @connect="showSettings = false; openConnections()" />
          <p v-if="confirmedRole === 'editor' && publicDelivery.status.value === 'sending'" class="reading-explanation" role="status">Sending public board changes…</p>
          <p v-if="confirmedRole === 'editor' && publicDelivery.status.value === 'delivered'" class="reading-explanation" role="status">Public board changes delivered.</p>
          <p v-if="publicDelivery.error.value" class="form-error reading-explanation" role="alert">Public board delivery: {{ publicDelivery.error.value }}</p>
          <button v-if="publicDelivery.error.value && publicDelivery.status.value === 'retry'" class="button button-small" type="button" :disabled="publicDelivery.busy.value" @click="publicDelivery.retry">Retry public delivery</button>
          <button v-if="publicDelivery.error.value && publicDelivery.status.value === 'blocked'" class="button button-small" type="button" @click="openConnections">Open Sync</button>
        </WorkspaceSettingsPanel>
      </template>
    </SchemaEditorDialog>
    <DialogWindow v-else-if="showSettings" window-id="settings-profile" :workspace-id="activeWorkspace.id" title="Settings" aria-label="Settings" @close="showSettings = false">
      <section class="dialog dialog-window-content">
        <ConnectedIdentityProfile v-if="identityPortalOrigin && identitySignedIn && currentIdentityProfile" :name="currentIdentityProfile.identity.displayName" :person-id="currentIdentityProfile.identity.personId" :avatar-data="currentAvatar" :portal-origin="identityPortalOrigin" @refresh="beginHeaderSignIn" @connect="beginIdentityDeviceEnrollment" />
        <IdentitySettingsPanel v-else :connect-device="identityPortalOrigin ? beginIdentityDeviceEnrollment : undefined" :workspace-id="activeWorkspace.id" :display-name="app.workspace.getCurrentProfile()?.identity.displayName ?? ''"
          :avatar-data="currentAvatar" :save-avatar="saveAvatar" :save-name="(name: string) => saveIdentityName(name, activeWorkspace.id, app.workspace.refreshIdentity)"
          :name-provided="identityNameProvided" :name-options="profileConflicts.names" :photo-options="profileConflicts.photos" :profile-revision="profileRevision || undefined" :profile-load-error="profileLoadError" :retry-profile-load="retryProfileLoad" :save-profile="saveProfile">
          <WorkspacePrivateRecoveryPanel :selected-workspace-title="activeWorkspace.title" :create-backup="createPrivateRecovery" :create-unavailable-reason="privateRecoveryUnavailableReason"
            :inspect-file="inspectPrivateRecovery" :restore="restorePrivateRecovery" :has-workspace-copy="hasWorkspaceCopy"
            :workspace-title="workspaceTitle" :current-person-id="chat.personId.value" />
        </IdentitySettingsPanel>
        <p v-if="avatarNotice" role="status">{{ avatarNotice }}</p>
      </section>
    </DialogWindow>
    <RustyStatusDialog v-if="showRustyStatus" :workspace-id="activeWorkspace.id" :ready="ready.value" :profile="app.workspace.getCurrentProfile" :boards="availableWorkspaces" :read-workspace-doc="app.workspace.readWorkspaceDoc" :controller="app.collaboration.device.blindReplication" @close="showRustyStatus = false" />
    <AutomationConnectionDialog v-if="connectingAutomation && ready.value" :workspace-id="activeWorkspace.id" :ready="ready.value" :profile="currentIdentityProfile" :boards="availableWorkspaces" :describe="describeAutomationBoard" :export-packet="exportAutomationConnection" @sign-in="beginHeaderSignIn" />
    <IdentityBoardLoadingNotice v-if="browserSignInReturn.boardLoading.value || browserSignInReturn.boardLoadError.value" :error="browserSignInReturn.boardLoadError.value" @retry="retryIdentityBoards" />
    <template v-if="boardVisible">

    <TransitionGroup name="notice" tag="aside" class="notice-overlay" aria-live="polite" aria-atomic="true" @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
      <div v-for="error in workspaceAccessErrors" :key="error" role="alert" class="notice notice-error">{{ error }}. Other boards remain available. You can export this board and import it as a new board.</div>
      <div v-if="storageError && !showItemForm" key="storage-error" role="alert" class="notice notice-error">
        <span>{{ storageError }}</span>
        <button type="button" class="notice-dismiss" aria-label="Dismiss storage notice" @click="storageError = ''">×</button>
      </div>
      <div v-if="notice" :key="notice" class="notice" role="status">
        <span>{{ notice }}</span>
        <button v-if="archiveUndo && (notice === 'Item archived' || notice.startsWith('Restore failed'))" type="button" class="notice-undo" :disabled="undoSaving" @click="undoArchive">{{ undoSaving ? 'Restoring…' : 'Undo' }}</button>
        <button type="button" class="notice-dismiss" aria-label="Dismiss notice" @click="notice = ''">×</button>
      </div>
    </TransitionGroup>

    <div v-if="hasFilters" class="filter-summary" aria-live="polite">
      <span>{{ visibleItems ? 'Showing matching cards' : 'No matching cards' }}</span>
      <button class="button button-small button-quiet" type="button" @click="clearFilters">Clear search and filters</button>
    </div>

    <BoardSurface :key="boardRenderKey" :columns="visibleColumns" :items-for-column="itemsForColumn"
      :column-color="columnColor" :column-status="columnStatus" :is-column-collapsed="isColumnCollapsed"
      :has-filters="hasFilters" :entity-name="entityName" :board-title="activeWorkspace.title"
      :can-edit-items="canEditItems" :is-editing-board="isEditingBoard" :moved-column-id="movedColumnId"
      :card-presentation="boardCardPresentation" :on-element="setBoardElement"
      :class="{ 'board-editing': isEditingBoard, 'board-bin-open': visibleColumns.some(column => isArchiveColumn(column) && !isColumnCollapsed(column)) }"
      @toggle-column="toggleColumnCollapse" @edit-column="editingColumn = $event" @scroll="trackBoardScroll"
      @open="openCard" @select="openBoardItem" @discuss="conversations.openCardDiscussion" @task-toggle="toggleCardTask">
      <template #before-item="{ column, item, index }">
              <div v-if="index > 0 && !isEditingBoard && canEditItems && !isArchiveColumn(column)" class="card-add-gap"><button class="column-add-button card-insert-button" type="button" :aria-label="`Add ${entityName} between cards in ${column.title}, before ${item.title}`" :disabled="savingItem" @click="openAddItem(column.id, item.id)">{{ addItemLabel }}</button></div>
      </template>
      <template #add-item="{ column }">
        <button v-if="!isEditingBoard && canEditItems && !isArchiveColumn(column)" class="column-add-button" type="button" :aria-label="`Add ${entityName} to ${column.title}`" :disabled="savingItem" @click="openAddItem(column.id)">{{ addItemLabel }}</button>
      </template>
      <template #empty>
      <div v-if="hasFilters && !visibleColumns.length" class="board-empty">Try another search or clear filters to see all cards.</div>
      <form v-if="isEditingBoard" class="add-column-card" @submit.prevent="addBoardColumn"><label class="sr-only" for="new-board-column">New column</label><input id="new-board-column" v-model="newBoardColumnTitle" placeholder="New column" :disabled="addingBoardColumn" /><label><input type="checkbox" :checked="newBoardColumnArchive" :disabled="genericColumns.some(column => isArchiveColumn(column)) || addingBoardColumn" @change="selectArchiveColumn(($event.target as HTMLInputElement).checked)" /> Archive column</label><label><input v-model="newBoardColumnCollapsible" type="checkbox" :disabled="addingBoardColumn" /> Allow this column to collapse</label><button class="button button-primary" type="submit" :disabled="addingBoardColumn">{{ addingBoardColumn ? 'Adding…' : '+ Add column' }}</button><p v-if="addBoardColumnError" class="form-error" role="alert">{{ addBoardColumnError }}</p></form>
      </template>
    </BoardSurface>

    <BoardDragOverlay :controller="app.board" />

    <!-- Dialogs -->

    <ColumnDialog
      v-if="editingColumn"
      :key="editingColumn.id"
      :column-id="editingColumn.id"
      :workspace-id="activeWorkspace.id"
      :initial-title="editingColumn.title"
      :initial-collapsible="editingColumn.collapsible"
      :initial-archive="isArchiveColumn(editingColumn, activeBoard ?? undefined)"
      @close="editingColumn = null"
      @save="handleRenameColumn"
      @archive="handleArchiveColumn"
    />


    <ObjectConversationLayer v-if="showConversationLayer" :workspace-id="activeWorkspace.id" :workspace-title="activeWorkspace.title" :chat="chat" :conversations="conversations"
      :can-view="chatCanView" :read-only="!canEditItems" :connected="sync.isWorkspaceLive(activeWorkspace.id)" :member-avatars="memberAvatars" @workspaces="showWorkspaces = true" @chat-close="chat.open.value = false" @source-dismiss="conversations.sourceState.value = ''" />
    <aside v-if="chat.toast.value" class="chat-toast" role="status">
      <button class="button button-quiet" type="button" @click="chat.open.value = true">{{ chat.toast.value.text }}</button>
      <button class="icon-button" type="button" aria-label="Dismiss chat notification" @click="chat.toast.value = null">×</button>
    </aside>

    <SchemaEditorDialog
      v-if="showEntitySettings && activeBoard && getActiveDoc()"
      :workspace-id="activeWorkspace.id"
      :doc="getActiveDoc()!"
      :read-only="!canEditBoard"
      :board="activeBoard"
      :columns="genericColumns"
      :fields="boardFields"
      :templates="workspace.templates"
      :heads="currentDocHeads"
      mode="entity"
      @close="showEntitySettings = false"
      @apply="handleApplySchema"
      :save-template="handleSaveTemplate"
    />

    <ItemDetailDialog
      v-if="selectedItem"
      :workspace-id="activeWorkspace.id" :item="selectedItem" :columns="genericColumns" :card-stage-buttons="cardStageButtons(activeBoard, genericColumns)"
      :attachment-coverage="app.collaboration.device.blindReplication.attachmentCoverage.value"
      :move-to-column="moveCardToColumn" :archived="Boolean(selectedItem && isItemArchived(selectedItem))"
      :narrative="selectedItem ? cardNotes(selectedItem) : ''"
      :narrative-field-id="activeBoard?.cardPresentation?.narrativeFieldId"
      :read-only="!canEditItems"
      :item-saving="savingItem"
      :subitems="subitemsForSelectedItem"
      :fields="boardFields.filter(field => field.id !== activeBoard?.cardPresentation?.narrativeFieldId)"
      :documents="documentsFor(selectedItem.id)"
      :save-document="saveSelectedItemDocument"
      :update-document="updateDocumentMarkdown"
      :history="selectedItemHistory" :history-names="historyNames"
      :history-loading="archivedHistoryLoading" :history-error="archivedHistoryError"
      :history-notice="archivedHistoryNotice" :history-has-more="archivedHistoryHasMore"
      :archive-error="archiveError"
      :restore-saving="historyRestoreSaving"
      :restore-error="historyRestoreError"
      :restore-notice="historyRestoreNotice"
      :quick-note="quickNoteDraft"
      :note-saving="quickNoteSaving"
      :note-error="quickNoteError"
      @close="selectedItemId = null; historyRestoreError = ''; historyRestoreNotice = ''"
      @edit="editItem"
      @add-subitem="handleAddSubitem"
      @start-move="handleStartMove"
      @archive-item="handleArchiveItem" @restore-item="handleRestoreItem"
      @restore-version="restoreSelectedItemVersion"
      @load-earlier-history="loadEarlierItemHistory"
      @update:quick-note="quickNoteDraft = $event"
      @save-note="saveQuickNote(selectedItem)"
      @update-markdown="updateItemMarkdown"
    >
      <template #documents>
        <ItemDocuments :documents="documentsFor(selectedItem.id)" :workspace-id="activeWorkspace.id"
          :attachment-coverage="app.collaboration.device.blindReplication.attachmentCoverage.value"
          :read-only="!canEditItems" :save="saveSelectedItemDocument" :update="updateDocumentMarkdown" />
      </template>
    </ItemDetailDialog>

    <ItemFormDialog
      v-if="showItemForm" :workspace-id="activeWorkspace.id"
      :parent-id="itemFormParentValue" :entity-name="entityName"
      :fields="boardFields"
      :columns="itemFormColumns"
      :item="editingItem"
      :show-core-fields="!activeBoard?.cardPresentation?.titleFieldIds?.length"
      :hidden-field-ids="[...computedItemFieldIds, ...(boardFields.some(field => field.id === activeBoard?.cardPresentation?.narrativeFieldId && field.valueType === 'text') && activeBoard?.cardPresentation?.narrativeFieldId ? [activeBoard.cardPresentation.narrativeFieldId] : [])]"
      :initial-body="editingItem ? cardNotes(editingItem) : undefined"
      :fold-snapshot="editingFoldSnapshot"
      :required-narrative="Boolean(boardFields.find(field => field.id === activeBoard?.cardPresentation?.narrativeFieldId && field.valueType === 'text')?.required)"
      :computed-fields-message="computedItemFieldIds.length ? 'Values are calculated from configured rules.' : undefined"
      :error-message="itemFormError"
      :saving="savingItem"
      @cancel="showItemForm = false; editingItemId = null; itemFormError = ''; editingFoldSnapshot = undefined"
      @save="handleSaveItem"
    />

    <MoveItemDialog
      v-if="showMoveDialog && itemToMove"
      :workspace-id="activeWorkspace.id"
      :item="itemToMove"
      :candidate-parents="candidateParentsForMove"
      @close="showMoveDialog = false; itemToMove = null"
      @confirm="handleConfirmMove"
    />

    </template>
    <SyncDialog v-if="sync.isOpen.value" :workspace-id="activeWorkspace.id" :member-avatars="memberAvatars" :revoking-person-id="revokingPeer" @revoke-person="revokeWorkspacePeer" :blind-replication="app.collaboration.device.blindReplication"
      :my-device-removal="myDeviceRemoval"
      :pending-joins="sync.pendingJoins.value"
      @decide-join="sync.decideJoin"
      :step="sync.step.value"
      :title="sync.title.value"
      :qr-code="sync.qrCode.value"
      :invite-url="sync.inviteUrl.value"
      :copy-notice="sync.copyNotice.value"
      :owner-reconnect-review="sync.ownerReconnectReview.value" @start-owner-reconnect="sync.startOwnerReconnect"
      @approve-owner-reconnect="sync.approveOwnerReconnect" @cancel-owner-reconnect="sync.cancelOwnerReconnect"
      :error="sync.error.value" :can-reconnect-device="sync.canReconnectDevice.value" @reconnect-device="sync.reconnectDevice"
      :auth-code="sync.authCode.value"
      :invitation-workspace-title="sync.invitationWorkspaceTitle.value"
      :invitation-workspaces="sync.invitationWorkspaces.value"
      :available-workspaces="sync.availableWorkspaces.value" :selected-workspace-ids="sync.selectedWorkspaceIds.value"
      :selected-workspace-id="sync.selectedWorkspaceId.value"
      :mesh-members="meshMembers"
      v-bind="{ activeWorkspaceId: activeWorkspace.id, localDeviceId: sync.localDeviceId.value,
        removableDeviceWorkspaces: sync.removableDeviceWorkspaces, removeDevice: sync.removeDevice, enrollmentConflict: sync.enrollmentConflict.value }"
      :has-mesh="sync.meshPeers.value.some(peer => peer.workspaceId === activeWorkspace.id && !peer.revokedAt)" :current-person-id="chat.personId.value"
      :current-role="currentRole"
      :succession="activeSuccession"
      :can-claim-succession="canClaimSuccession"
      :can-manage-mesh="canManageAccess"
      :transferring-ownership="transferringOwnership" :leaving-mesh="leavingMesh"
      :mesh-action-error="peerAccessError"
      :workspace-connected="devicePresence === 'connected'" :workspace-reconnecting="devicePresence === 'reconnecting'"
      :mesh-diagnostic="sync.meshDiagnostic.value"
      :mesh-presence="meshPresence"
      :retry-at="activeMeshRetryAt"
      :network-online="sync.networkOnline.value"
      :live="sync.isEnabled.value"
      @update:selected-workspace-ids="sync.selectedWorkspaceIds.value = $event"
      @update:selected-workspace-id="sync.selectedWorkspaceId.value = $event"
      @select-sync-all="identityOwnerActions.addMyDevice"
      @select-sync-workspace="sync.selectSyncWorkspace"
      @generate-workspace-invite="generateWorkspaceInviteWithIdentity"
      @transfer-ownership="transferWorkspaceOwnership"
      @leave-mesh="leaveWorkspaceMesh"
      @set-successor="setWorkspaceSuccessor"
      @vote-successor="voteForWorkspaceSuccessor"
      @claim-succession="claimWorkspaceSuccession"
      @promote-peer="promoteWorkspacePeer"
      @request-enrollment="sync.requestEnrollment"
      :enrollment-device-name="sync.enrollmentDeviceName.value"
      :enrollment-same-identity="sync.enrollmentSameIdentity.value"
      @approve-device="sync.approveEnrollment"
      @decline-device="sync.declineEnrollment"
      @accept-and-join="sync.acceptWorkspaceJoin"
      @copy="sync.copyInvite"
      @dismiss="sync.dismiss"
      @stop="sync.stopLiveSync"
    />

  </TincanbanPageLayout>
  <BuildFooter />
  <IdentityPortalEnrollmentDialog v-if="ready.value && showIdentityPortal && identityPortalOrigin && currentIdentityProfile"
    :workspace-id="activeWorkspace.id" :portal-origin="identityPortalOrigin" :profile="currentIdentityProfile" :browser-return="browserSignInReturn.returning.value" :initial-mode="identityPortalMode" :complete-browser-sign-in="browserSignInReturn.complete" @close="browserSignInReturn.close" @completed="identityPortalFlow.complete" />
</template>

<style>
.startup-concealed { visibility: hidden; }
.startup-revealed { animation: startup-reveal 320ms ease-out; }
.startup-cover-enter-active, .startup-cover-leave-active { transition: opacity 320ms ease; }
.startup-cover-enter-from, .startup-cover-leave-to { opacity: 0; }
.startup-cover-leave-active { pointer-events: none; }
@keyframes startup-reveal { from { opacity: 0; } to { opacity: 1; } }
</style>
