<!-- Workspace role gates are enforced again at command and sync boundaries. -->
<script setup lang="ts">
import { useAppController } from "./app/useAppController"
import { useAppItemDocumentSave } from "./app/useAppItemDocumentSave"
import { isArchiveColumn, isItemArchived } from "./domain/archive"
import { cardStageButtons } from "./domain/cardStageButtons"
import { useCardAges } from "./app/useAgingClock"
import { showEnteringElement, hideLeavingElement } from "./ui/modal"
import ModalLayer from "./components/ModalLayer.vue"
import TincanbanPageLayout from "./components/TincanbanPageLayout.vue"
import TincanbanHeading from "./components/TincanbanHeading.vue"
import BrandCan from "./components/BrandCan.vue"
import BoardDragOverlay from "./components/BoardDragOverlay.vue"
import BoardSurface from "./components/BoardSurface.vue"
import BoardToolbar from "./components/BoardToolbar.vue"
import { useObjectConversations } from "./app/useObjectConversations"
import ObjectConversationLayer from "./components/ObjectConversationLayer.vue"
import MobileDrawer from "./components/MobileDrawer.vue"
import SaveState from "./components/SaveState.vue"
import StartupStatus from "./components/StartupStatus.vue"
import { LazyItemDocuments as ItemDocuments } from "./app/lazyItemDocuments"
import { ItemFormDialog } from "./app/lazyItemFormDialog"
import BuildFooter from "./components/BuildFooter.vue"
import ReleaseUpgradeNotice from "./components/ReleaseUpgradeNotice.vue"
import type { saveIdentityName as identityNameSaverType } from "./app/identityName"
import { computed, defineAsyncComponent, onBeforeUnmount, ref, type Component } from "vue"
import type { NarrativeFoldSources } from "./domain/commandTypes"
import { useColumnCollapse } from "./ui/useColumnCollapse"
import { useAppViewState } from "./app/useAppViewState"
import { useBoardAddress } from "./app/useBoardAddress"
import { useMemberAvatars } from "./app/useMemberAvatars"
import { useAppPublicBoards } from "./app/useAppPublicBoards"
import { AutosaveTextarea, CausalChangeReview, ColumnDialog, IdentityRecoveryDialog, IdentitySettingsPanel, ItemDetailDialog, LeadDetailWindow, MoveItemDialog, QuickNoteForm, SchemaEditorDialog, startOfflineDetailPreload, WorkspaceSettingsPanel, WorkspacesDialog } from "./app/lazyUiComponents"

const app = useAppController()
const boardAddress = useBoardAddress(app.workspace)
const routeContent = ref<HTMLElement | null>(null)
type IdentityNameSaver = typeof identityNameSaverType
const saveIdentityName: IdentityNameSaver = async (...args) => (await import("./app/identityName")).saveIdentityName(...args)
const LeadArtifactsSection = defineAsyncComponent(() => import("./components/LeadArtifactsSection.vue") as Promise<{ default: Component }>)
const LeadOriginalPostingEvidence = defineAsyncComponent(() => import("./components/LeadOriginalPostingEvidence.vue") as Promise<{ default: Component }>)
const PublicBoardControls = defineAsyncComponent(() => import("./components/PublicBoardControls.vue") as Promise<{ default: Component }>)
const { historyNames, stopSyncForIdentityRestore, restoredIdentity, SyncDialog, reviewCausalChange, dismissCausalChange, restoreCausalChange, chatCanView, uiReady, boardVisible: workspaceBoardVisible, startupMessage, startupCoverVisible } = useAppViewState(app, routeContent)
const boardAddressResolved = computed(() => boardAddress.status.value !== "resolving" && boardAddress.status.value !== "unavailable")
const boardVisible = computed(() => workspaceBoardVisible.value && boardAddressResolved.value)
const conversations = useObjectConversations(app)
const [showIdentityRecovery, showSettings] = [ref(false), ref(false)]
const syncInitialTab = ref<"Participants" | "Rusty" | "Backups">("Participants")
function openConnections(tab: "Participants" | "Rusty" | "Backups") {
  showSettings.value = false
  syncInitialTab.value = tab
  sync.open()
}
const editingFoldSnapshot = ref<NarrativeFoldSources | undefined>()
const { workspace, ready, saveState, availableWorkspaces, archivedWorkspaces, causalReview, causalReviewError, activeWorkspace, activeBoard, docVersion, isBlankBoard, genericColumns, boardFields, getActiveDoc, documentsFor } = app.workspace
onBeforeUnmount(startOfflineDetailPreload(() => ready.value))
const { state: ui, controls: uiControls } = app.ui
const { isCollapsed: isColumnCollapsed, toggle: toggleColumnCollapse } = useColumnCollapse(() => activeWorkspace.id, () => hasFilters.value)
const {
  detailDialog, importInput, showArtifactForm, search, filters,
  notice, archiveUndo, undoSaving, archiveError, historyRestoreSaving,
  historyRestoreError, historyRestoreNotice, artifactError,
  showWorkspaces, showEntitySettings, isEditingBoard,
  newBoardColumnTitle, boardRef, boardRenderKey, movedItemId, movedColumnId,
  showItemForm, itemFormError, savingItem, editingColumn,
  selectedItemId, editingItemId, itemToMove, showMoveDialog, storageError,
  quickNoteDraft, quickNoteSaving, quickNoteError, hasExperimentalMcp,
  showMobileMenu, menuButtonRef, startupError, artifactDraft,
} = ui
const { toggleMobileMenu, closeMobileMenu } = uiControls
const {
  workspaceLabel, entityName, addItemLabel, itemFormColumns, itemFormParentValue,
  computedItemFieldIds, itemFormOptionValues, visibleItems, hasFilters, workspacePresenceSummary,
  visibleColumns, clearFilters, leadForItem, cardNotes, cardFields, cardNoteSearchMatch, expandFilteredCards, columnColor, columnStatus, itemsForColumn,
  trackBoardScroll, selectedItem, subitemsForSelectedItem,
  selectedItemHistory, editingItem, candidateParentsForMove, archivedHistoryLoading, archivedHistoryError,
  archivedHistoryNotice, archivedHistoryHasMore, loadEarlierItemHistory,
} = app.board
const { sync, chat } = app.collaboration.device
const { confirmedRole, currentRole, workspaceAccessErrors, workspaceRoleStatus, canEditItems, canEditBoard, canManageAccess, canRenameWorkspace } = app.collaboration.permissions
const { devicePresence, meshPresence, meshPresenceLabel,
  activeMeshRetryAt, meshMembers, activeSuccession,
  canClaimSuccession, transferringOwnership, leavingMesh, revokingPeer,
  peerAccessError, transferWorkspaceOwnership,
  leaveWorkspaceMesh, setWorkspaceSuccessor, voteForWorkspaceSuccessor,
  claimWorkspaceSuccession, revokeWorkspacePeer, promoteWorkspacePeer,
} = app.collaboration.mesh
const {
  selectedLead, selectedLeadItem, selectedDocuments, selectedArtifacts, availableArtifactTemplates, openBoardItem,
  restoreSelectedItemVersion, saveQuickNote, updateDocumentMarkdown, updateItemMarkdown, handleSaveTemplate,
  openArtifactForm, submitArtifact, moveCardToColumn, handleUpdateRejectionReason,
  exportWorkspace, createPrivateRecovery, privateRecoveryUnavailableReason, inspectPrivateRecovery, restorePrivateRecovery, hasWorkspaceCopy, workspaceTitle,
  openImport, importWorkspace, workspaceImportState, closeDetail: closeDetailNow, handleCreateWorkspace,
  handleSwitchWorkspace, handleRenameWorkspace, handleArchiveWorkspace, handleRestoreWorkspace, openAddItem,
  handleSaveItem, currentDocHeads, handleApplySchema, handleApplyWorkspaceSettings, settingsSaveError, settingsSaving,
  handleArchiveItem, handleRestoreItem, undoArchive, handleOpenItemEdit, handleAddSubitem,
  handleStartMove, handleConfirmMove, handleRenameColumn, handleArchiveColumn, addBoardColumn, newBoardColumnArchive, newBoardColumnCollapsible, addingBoardColumn, addBoardColumnError, selectArchiveColumn,
} = app.actions
const { publicAccess, publicDelivery, backgroundPublicDeliveryError } = useAppPublicBoards(app, uiReady)
const rejectionEditor = ref<{ flush: () => Promise<boolean> }>()
async function closeDetail() { if (!rejectionEditor.value || await rejectionEditor.value.flush()) closeDetailNow() }
function openCard(item: Parameters<typeof openBoardItem>[0], event: MouseEvent) { conversations.openCard(item, event) }
function toggleCardTask(item: Parameters<typeof openBoardItem>[0], markdown: string) { void updateItemMarkdown(item, markdown) }

const { saveSelectedLeadDocument, saveSelectedItemDocument } = useAppItemDocumentSave(app)
async function editItem(item: Parameters<typeof openBoardItem>[0]) {
  if (rejectionEditor.value && !(await rejectionEditor.value.flush())) return
  const { createNarrativeEditHandler } = await import("./app/narrativeEditor")
  createNarrativeEditHandler(editingFoldSnapshot, activeBoard, leadForItem, () => getActiveDoc()?.entities ?? {}, handleOpenItemEdit)(item)
}
async function applyWorkspaceSettings(payload: Parameters<typeof handleApplyWorkspaceSettings>[0]) { if (await handleApplyWorkspaceSettings(payload)) showSettings.value = false }
const cardAgeFor = useCardAges(() => activeBoard.value?.cardAgingPolicy)
function setBoardElement(element: HTMLElement | null) { boardRef.value = element }
function boardCardPresentation(item: Parameters<typeof cardNotes>[0], column: Parameters<typeof cardAgeFor>[1]) {
  const match = cardNoteSearchMatch(item)
  const age = cardAgeFor(item, column)
  return { lead: leadForItem(item), notes: cardNotes(item), fields: cardFields(item),
    hasFilters: expandFilteredCards.value || Boolean(match), showFields: hasFilters.value,
    searchQuery: match?.query, searchMatchIndex: match?.index,
    discussion: conversations.cardDiscussions.value.get(item.id), moved: movedItemId.value === item.id,
    ageLevel: age?.level, ageLabel: age?.label }
}
const { memberAvatars, currentAvatar, saveAvatar, avatarNotice, profileConflicts, profileRevision } = useMemberAvatars(app.workspace)
function saveProfile(draft: { name: string; avatarData?: string | null; revision?: string }) {
  return saveIdentityName(draft.name, activeWorkspace.id, app.workspace.refreshIdentity,
    { avatarData: draft.avatarData, expectedRevision: draft.revision })
}
</script>

<template>
  <ReleaseUpgradeNotice />
  <Transition name="startup-cover" @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
    <StartupStatus v-if="startupCoverVisible" expanded :message="startupMessage" :view-only="false" :error="null" />
  </Transition>
  <TincanbanPageLayout :class="{ 'startup-concealed': startupCoverVisible, 'startup-revealed': !startupCoverVisible }" :inert="startupCoverVisible || undefined" :busy="!uiReady && !startupError">
    <template #header>
      <button class="brand brand-button" type="button" aria-label="Open workspaces" :disabled="!uiReady || !boardAddressResolved" @click="showWorkspaces = true">
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
          :disabled="!uiReady || !boardAddressResolved"
          :aria-expanded="showMobileMenu ? 'true' : 'false'"
          aria-controls="mobile-drawer"
          @click="toggleMobileMenu"
        >
          <span class="hamburger-icon" aria-hidden="true">☰</span>
        </button>
      </div>
      <div class="top-actions top-actions-desktop" :inert="!uiReady || !boardAddressResolved || undefined">
        <button class="button button-quiet" type="button" aria-label="Workspace chat" @click="chat.open.value = true">Chat<span v-if="chat.unread.value"> · {{ chat.unread.value }}</span></button>
        <button class="button button-quiet" type="button" @click="openConnections('Participants')">Sync</button>
        <button class="button button-quiet" type="button" aria-label="Settings" @click="showSettings = true">Settings</button>
        <button v-if="canEditBoard" class="button button-quiet" type="button" @click="isEditingBoard = !isEditingBoard">{{ isEditingBoard ? "Done" : "Edit board" }}</button>
        <button v-if="isEditingBoard" class="button button-primary" type="button" @click="showEntitySettings = true">Edit {{ entityName }}</button>
        <a v-if="hasExperimentalMcp" class="button button-quiet agent-guide-desktop" href="/agent">Agent guide</a>
        <input ref="importInput" class="sr-only" type="file" accept=".tincanban,.match,application/vnd.tincanban+zip,application/vnd.match+zip" @change="importWorkspace" />
      </div>
    </template>

    <section v-if="boardAddress.status.value === 'unavailable'" ref="routeContent" class="board-address-unavailable" role="alert">
      <h1>Board unavailable</h1>
      <p>This board is not available to the current identity on this device.</p>
      <button class="button button-small" type="button" @click="boardAddress.retry">Try again</button>
      <a class="button button-small" href="/">Open local boards</a>
    </section>
    <p v-else-if="boardAddress.status.value === 'resolving'" ref="routeContent" class="board-address-progress" role="status">Opening board…</p>

    <CausalChangeReview v-if="boardVisible && (causalReview.length || causalReviewError)" :changes="causalReview" :error="causalReviewError"
      :can-review="uiReady && canEditItems" :review-change="reviewCausalChange"
      :dismiss-change="dismissCausalChange" :restore-change="restoreCausalChange" />

    <BoardToolbar v-if="boardVisible" v-model:search="search" v-model:filters="filters" :columns="genericColumns" :fields="boardFields"
      :placeholder="isBlankBoard ? 'Search cards' : 'Search company, role, notes'" :inert="!boardVisible || undefined">
      <SaveState :state="saveState" :settled-label="workspacePresenceSummary" aria-label="Workspace presence" />
    </BoardToolbar>

    <Transition name="startup-cover" @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
      <StartupStatus v-if="!startupCoverVisible && (!uiReady || startupError)" :message="startupMessage" :view-only="boardVisible" :error="startupError" />
    </Transition>

    <template v-if="boardVisible">
    <MobileDrawer
      :is-open="showMobileMenu"
      :active-workspace-title="workspaceLabel"
      :is-editing-board="isEditingBoard"
      :can-edit-board="canEditBoard"
      :entity-name="entityName"
      @close="closeMobileMenu"
      @open-workspaces="showWorkspaces = true"
      @open-settings="showSettings = true"
      @toggle-board-edit="isEditingBoard = !isEditingBoard"
      @open-entity-settings="showEntitySettings = true"
      @open-sync="openConnections('Participants')"
    />

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
              <div v-if="index > 0 && !isEditingBoard && canEditItems && !isArchiveColumn(column)" class="card-add-gap"><button class="column-add-button card-insert-button" type="button" :aria-label="`Add ${entityName} between cards in ${column.title}, before ${item.title}`" @click="openAddItem(column.id, item.id)">{{ addItemLabel }}</button></div>
      </template>
      <template #add-item="{ column }">
        <button v-if="!isEditingBoard && canEditItems && !isArchiveColumn(column)" class="column-add-button" type="button" :aria-label="`Add ${entityName} to ${column.title}`" @click="openAddItem(column.id)">{{ addItemLabel }}</button>
      </template>
      <template #empty>
      <div v-if="hasFilters && !visibleColumns.length" class="board-empty">Try another search or clear filters to see all cards.</div>
      <form v-if="isEditingBoard" class="add-column-card" @submit.prevent="addBoardColumn"><label class="sr-only" for="new-board-column">New column</label><input id="new-board-column" v-model="newBoardColumnTitle" placeholder="New column" :disabled="addingBoardColumn" /><label><input type="checkbox" :checked="newBoardColumnArchive" :disabled="genericColumns.some(column => isArchiveColumn(column)) || addingBoardColumn" @change="selectArchiveColumn(($event.target as HTMLInputElement).checked)" /> Archive column</label><label><input v-model="newBoardColumnCollapsible" type="checkbox" :disabled="addingBoardColumn" /> Allow this column to collapse</label><button class="button button-primary" type="submit" :disabled="addingBoardColumn">{{ addingBoardColumn ? 'Adding…' : '+ Add column' }}</button><p v-if="addBoardColumnError" class="form-error" role="alert">{{ addBoardColumnError }}</p></form>
      </template>
    </BoardSurface>

    <BoardDragOverlay :controller="app.board" />

    <!-- Dialogs -->
    <WorkspacesDialog
      v-if="showWorkspaces"
      :workspaces="availableWorkspaces" :archived-workspaces="archivedWorkspaces"
      :active-workspace-id="activeWorkspace.id"
      :importing="workspaceImportState.busy" :import-error="workspaceImportState.error"
      :read-owner="async (id: string) => (await app.workspace.readWorkspaceDoc(id)).ownerPersonId"
      :current-person-id="chat.personId.value" :current-identity-name="chat.displayName.value" :known-people="chat.members.value"
      :rename-workspace="handleRenameWorkspace" :archive-workspace="handleArchiveWorkspace" :restore-workspace="handleRestoreWorkspace"
      :create-workspace="handleCreateWorkspace"
      :can-rename-workspace="canRenameWorkspace"
      @close="showWorkspaces = false"
      @switch="handleSwitchWorkspace"
      @import="openImport"
    />

    <ColumnDialog
      v-if="editingColumn"
      :column-id="editingColumn.id"
      :initial-title="editingColumn.title"
      :initial-collapsible="editingColumn.collapsible"
      :initial-archive="isArchiveColumn(editingColumn, activeBoard ?? undefined)"
      @close="editingColumn = null"
      @save="handleRenameColumn"
      @archive="handleArchiveColumn"
    />

    <SchemaEditorDialog
      v-if="showSettings && activeBoard && getActiveDoc()"
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
        <IdentitySettingsPanel :display-name="app.workspace.getCurrentProfile()?.identity.displayName ?? ''" :avatar-data="currentAvatar" :save-avatar="saveAvatar" :save-name="(name: string) => saveIdentityName(name, activeWorkspace.id, app.workspace.refreshIdentity)"
          :name-options="profileConflicts.names" :photo-options="profileConflicts.photos" :profile-revision="profileRevision || undefined" :save-profile="saveProfile" @recovery="showIdentityRecovery = true" />
        <p v-if="avatarNotice" role="status">{{ avatarNotice }}</p>
      </template>
      <template #workspace>
        <WorkspaceSettingsPanel :workspace="app.workspace" :workspace-id="activeWorkspace.id"
          :controller="app.collaboration.device.blindReplication" :owner="canManageAccess" :presence="meshPresenceLabel" :save-state="saveState" :access-role="confirmedRole"
          :diagnostic="sync.meshDiagnostic.value" :members="meshMembers">
          <PublicBoardControls v-if="uiReady" :access="publicAccess" />
          <p v-if="backgroundPublicDeliveryError" class="form-error reading-explanation" role="alert">Public board delivery: {{ backgroundPublicDeliveryError }}</p>
          <p v-if="confirmedRole === 'editor' && publicDelivery.status.value === 'sending'" class="reading-explanation" role="status">Sending public board changes…</p>
          <p v-if="confirmedRole === 'editor' && publicDelivery.status.value === 'delivered'" class="reading-explanation" role="status">Public board changes delivered.</p>
          <p v-if="publicDelivery.error.value" class="form-error reading-explanation" role="alert">Public board delivery: {{ publicDelivery.error.value }}</p>
          <button v-if="publicDelivery.error.value" class="button button-small" type="button" :disabled="publicDelivery.busy.value" @click="publicDelivery.retry">Retry public delivery</button>
        </WorkspaceSettingsPanel>
      </template>
    </SchemaEditorDialog>
    <ModalLayer v-else-if="showSettings" @close="showSettings = false">
      <section class="dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="dialog-head"><div><span class="eyebrow">Identity</span><h2>Settings</h2></div><button class="icon-button" type="button" aria-label="Close" @click="showSettings = false">×</button></div>
        <IdentitySettingsPanel :display-name="app.workspace.getCurrentProfile()?.identity.displayName ?? ''"
          :avatar-data="currentAvatar" :save-avatar="saveAvatar" :save-name="(name: string) => saveIdentityName(name, activeWorkspace.id, app.workspace.refreshIdentity)"
          :name-options="profileConflicts.names" :photo-options="profileConflicts.photos" :profile-revision="profileRevision || undefined" :save-profile="saveProfile" @recovery="showIdentityRecovery = true" />
        <p v-if="avatarNotice" role="status">{{ avatarNotice }}</p>
      </section>
    </ModalLayer>
    <IdentityRecoveryDialog v-if="showIdentityRecovery" :before-restore="stopSyncForIdentityRestore" :display-name="app.workspace.getCurrentProfile()?.identity.displayName ?? ''" @close="showIdentityRecovery = false" @restored="restoredIdentity" />

    <ObjectConversationLayer :workspace-id="activeWorkspace.id" :workspace-title="activeWorkspace.title" :chat="chat" :conversations="conversations"
      :can-view="chatCanView" :read-only="!canEditItems" :connected="sync.isWorkspaceLive(activeWorkspace.id)" :member-avatars="memberAvatars" @workspaces="showWorkspaces = true" @chat-close="chat.open.value = false" @source-dismiss="conversations.sourceState.value = ''" />
    <aside v-if="chat.toast.value" class="chat-toast" role="status">
      <button class="button button-quiet" type="button" @click="chat.open.value = true">{{ chat.toast.value.text }}</button>
      <button class="icon-button" type="button" aria-label="Dismiss chat notification" @click="chat.toast.value = null">×</button>
    </aside>

    <SchemaEditorDialog
      v-if="showEntitySettings && activeBoard && getActiveDoc()"
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
      :narrative-field-id="activeBoard?.preset?.bindings['field.notes']"
      :read-only="!canEditItems"
      :subitems="subitemsForSelectedItem"
      :fields="boardFields.filter(field => field.id !== activeBoard?.preset?.bindings['field.notes'] || field.valueType !== 'text')"
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
      :show-core-fields="isBlankBoard"
      :hidden-field-ids="[...computedItemFieldIds, ...(boardFields.some(field => field.id === activeBoard?.preset?.bindings['field.notes'] && field.valueType === 'text') && activeBoard?.preset?.bindings['field.notes'] ? [activeBoard.preset.bindings['field.notes']] : [])]"
      :initial-body="editingItem ? cardNotes(editingItem) : undefined"
      :fold-snapshot="editingFoldSnapshot"
      :required-narrative="Boolean(boardFields.find(field => field.id === activeBoard?.preset?.bindings['field.notes'] && field.valueType === 'text')?.required)"
      :computed-fields-message="computedItemFieldIds.length ? 'Priority and fit are calculated from workspace preferences.' : undefined"
      :option-values="itemFormOptionValues"
      :error-message="itemFormError"
      :saving="savingItem"
      @cancel="showItemForm = false; editingItemId = null; itemFormError = ''; editingFoldSnapshot = undefined"
      @save="handleSaveItem"
    />

    <MoveItemDialog
      v-if="showMoveDialog && itemToMove"
      :item="itemToMove"
      :candidate-parents="candidateParentsForMove"
      @close="showMoveDialog = false; itemToMove = null"
      @confirm="handleConfirmMove"
    />
    <LeadDetailWindow v-if="selectedLead" :lead="selectedLead" :item="selectedLeadItem" :board="activeBoard" :columns="genericColumns"
      :workspace-id="activeWorkspace.id" :read-only="!canEditItems" :narrative="selectedLeadItem ? cardNotes(selectedLeadItem) : ''" :move="moveCardToColumn"
      :history="selectedItemHistory" :history-names="historyNames" :history-loading="archivedHistoryLoading" :history-error="archivedHistoryError"
      :history-notice="archivedHistoryNotice" :history-has-more="archivedHistoryHasMore"
      :restore-saving="historyRestoreSaving" :restore-error="historyRestoreError" :restore-notice="historyRestoreNotice"
      @close="closeDetail" @edit="editItem" @update-markdown="selectedLeadItem && updateItemMarkdown(selectedLeadItem, $event)" @content="detailDialog = $event"
      @restore-version="restoreSelectedItemVersion" @load-earlier-history="loadEarlierItemHistory">
      <template #sourceEvidence>
        <LeadOriginalPostingEvidence :lead-id="selectedLead.id" :lead-url="selectedLead.url"
          :workspace-id="activeWorkspace.id" :document="getActiveDoc()" :document-version="docVersion" />
      </template>
      <template #toolbar>
        <p v-if="archiveError" class="form-error" role="alert">{{ archiveError }}</p>
        <button v-if="archiveUndo && archiveUndo.workspaceId === activeWorkspace.id" class="button button-small" type="button" :disabled="undoSaving" @click="undoArchive">{{ undoSaving ? 'Restoring…' : 'Undo archive' }}</button>
      </template>
      <template #primary>
          <LeadArtifactsSection v-model="artifactDraft" :artifacts="selectedArtifacts" :templates="availableArtifactTemplates"
            :read-only="!canEditItems" :show-form="showArtifactForm" :error="artifactError"
            @toggle="showArtifactForm ? showArtifactForm = false : openArtifactForm()" @submit="submitArtifact" />
          <ItemDocuments v-if="selectedLeadItem" :documents="selectedDocuments" :workspace-id="activeWorkspace.id" :attachment-coverage="app.collaboration.device.blindReplication.attachmentCoverage.value" :read-only="!canEditItems" :save="saveSelectedLeadDocument" :update="updateDocumentMarkdown" />
      </template>
      <template #inspector>
        <QuickNoteForm
          v-if="selectedLeadItem"
          v-model="quickNoteDraft"
          :saving="quickNoteSaving"
          :error="quickNoteError"
          :read-only="!canEditItems"
          @save="saveQuickNote(selectedLeadItem)"
        />
        <section v-if="selectedLead.status === 'rejected' || selectedLead.rejectionReason" class="detail-section">
          <span class="detail-label">Rejection notes / retrospective</span>
          <AutosaveTextarea
            :key="selectedLead.id" ref="rejectionEditor" :read-only="!canEditItems" :value="selectedLead.rejectionReason ?? ''"
            :save="(reason: string) => handleUpdateRejectionReason(activeWorkspace.id, selectedLead!.id, reason)"
            placeholder="Optional rejection reason or retrospective note (what went wrong)…" label="Rejection notes" />
        </section>

      </template>
    </LeadDetailWindow>
    </template>
    <SyncDialog v-if="sync.isOpen.value" :initial-tab="syncInitialTab" :member-avatars="memberAvatars" :revoking-person-id="revokingPeer" @revoke-person="revokeWorkspacePeer" :blind-replication="app.collaboration.device.blindReplication"
      :pending-joins="sync.pendingJoins.value"
      @decide-join="sync.decideJoin"
      :step="sync.step.value"
      :title="sync.title.value"
      :qr-code="sync.qrCode.value"
      :invite-url="sync.inviteUrl.value"
      :copy-notice="sync.copyNotice.value"
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
      :retry-at="activeMeshRetryAt"
      :network-online="sync.networkOnline.value"
      :live="sync.isEnabled.value"
      @update:selected-workspace-ids="sync.selectedWorkspaceIds.value = $event"
      @update:selected-workspace-id="sync.selectedWorkspaceId.value = $event"
      @select-sync-all="sync.selectSyncAll"
      @select-sync-workspace="sync.selectSyncWorkspace"
      @generate-workspace-invite="sync.generateWorkspaceInvite"
      @transfer-ownership="transferWorkspaceOwnership"
      @leave-mesh="leaveWorkspaceMesh"
      @set-successor="setWorkspaceSuccessor"
      @vote-successor="voteForWorkspaceSuccessor"
      @claim-succession="claimWorkspaceSuccession"
      @promote-peer="promoteWorkspacePeer"
      @request-enrollment="sync.requestEnrollment"
      :enrollment-device-name="sync.enrollmentDeviceName.value"
      @approve-device="sync.approveEnrollment"
      @decline-device="sync.declineEnrollment"
      @accept-and-join="sync.acceptWorkspaceJoin"
      @copy="sync.copyInvite"
      :export-workspace="exportWorkspace"
      :create-private-recovery="createPrivateRecovery"
      :private-recovery-unavailable-reason="privateRecoveryUnavailableReason"
      :inspect-private-recovery="inspectPrivateRecovery"
      :restore-private-recovery="restorePrivateRecovery"
      :has-workspace-copy="hasWorkspaceCopy"
      :workspace-title="workspaceTitle"
      @dismiss="sync.dismiss"
      @start="sync.startDurableMesh"
      @stop="sync.stopLiveSync"
    />

  </TincanbanPageLayout>
  <BuildFooter />
</template>

<style>
.board-address-unavailable { max-width: 38rem; margin: 10vh auto; padding: var(--space-5); text-align: center; }
.board-address-progress { max-width: 38rem; margin: 10vh auto; padding: var(--space-5); text-align: center; }
.board-address-unavailable h1 { margin: 0 0 var(--space-2); }
.board-address-unavailable p { margin: 0 0 var(--space-4); }
.startup-concealed { visibility: hidden; }
.startup-revealed { animation: startup-reveal 320ms ease-out; }
.startup-cover-enter-active, .startup-cover-leave-active { transition: opacity 320ms ease; }
.startup-cover-enter-from, .startup-cover-leave-to { opacity: 0; }
.startup-cover-leave-active { pointer-events: none; }
@keyframes startup-reveal { from { opacity: 0; } to { opacity: 1; } }
</style>
