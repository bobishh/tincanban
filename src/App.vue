<!-- Workspace role gates are enforced again at command and sync boundaries. -->
<script setup lang="ts">
import { MarkdownContent } from "./ui/markdownContent"
import { useAppController } from "./app/useAppController"
import { isArchiveColumn, isItemArchived } from "./domain/archive"
import { cardStageButtons } from "./domain/cardStageButtons"
import { useCardAges } from "./app/useAgingClock"
import { showEnteringElement, hideLeavingElement } from "./ui/modal"
import { artifactKindLabels, priorityLabels, type DocumentInput } from "./types"
import ModalLayer from "./components/ModalLayer.vue"
import TincanbanPageLayout from "./components/TincanbanPageLayout.vue"
import TincanbanHeading from "./components/TincanbanHeading.vue"
import BrandCan from "./components/BrandCan.vue"
import BoardDragOverlay from "./components/BoardDragOverlay.vue"
import ColumnFoldCover from "./components/ColumnFoldCover.vue"
import BoardItemCard from "./components/BoardItemCard.vue"
import LeadFilters from "./components/LeadFilters.vue"
import { useObjectConversations } from "./app/useObjectConversations"
import ObjectConversationLayer from "./components/ObjectConversationLayer.vue"
import CardStageStrip from "./components/CardStageStrip.vue"
import AutosaveTextarea from "./components/AutosaveTextarea.vue"
import MobileDrawer from "./components/MobileDrawer.vue"
import SaveState from "./components/SaveState.vue"
import StartupStatus from "./components/StartupStatus.vue"
import { LazyItemDocuments as ItemDocuments } from "./app/lazyItemDocuments"
import { ItemFormDialog } from "./app/lazyItemFormDialog"
import QuickNoteForm from "./components/QuickNoteForm.vue"
import BuildFooter from "./components/BuildFooter.vue"
import { saveIdentityName } from "./app/identityName"
import { defineAsyncComponent, onBeforeUnmount, ref } from "vue"
import type { Component } from "vue"
import type { NarrativeFoldSources } from "./domain/commandTypes"
import { createNarrativeEditHandler } from "./app/narrativeEditor"
import { useColumnCollapse } from "./app/useColumnCollapse"
import { useAppViewState } from "./app/useAppViewState"
import { useMemberAvatars } from "./app/useMemberAvatars"
import { CausalChangeReview, ColumnDialog, IdentityRecoveryDialog, IdentitySettingsPanel, ItemDetailDialog, MoveItemDialog, SchemaEditorDialog, SpatialWindow, startOfflineDetailPreload, WorkspaceConnectionsPanel, IdentityPhotoPanel, WorkspacesDialog } from "./app/lazyUiComponents"

const app = useAppController()
const PublicBoardControls = defineAsyncComponent(() => import("./components/PublicBoardControls.vue") as Promise<{ default: Component }>)
const { SyncDialog, reviewCausalChange, dismissCausalChange, restoreCausalChange, chatCanView, uiReady, boardVisible, startupMessage, startupCoverVisible } = useAppViewState(app)
const conversations = useObjectConversations(app)
const [showIdentityRecovery, showSettings] = [ref(false), ref(false)]
const syncInitialTab = ref<"Participants" | "Rusty" | "Backups">("Participants")
function openConnections(tab: "Participants" | "Rusty" | "Backups") {
  showSettings.value = false
  syncInitialTab.value = tab
  sync.open()
}
const editingFoldSnapshot = ref<NarrativeFoldSources | undefined>()
const stopSyncForIdentityRestore = () => app.collaboration.device.sync.shutdown()
const restoredIdentity = () => window.location.reload()
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
  selectedItemHistory, editingItem, candidateParentsForMove,
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
  restoreSelectedItemVersion, saveQuickNote, submitDocument, updateDocumentMarkdown, updateItemMarkdown, handleSaveTemplate,
  openArtifactForm, submitArtifact, moveCardToColumn, handleUpdateRejectionReason,
  exportWorkspace, openImport, importWorkspace, closeDetail: closeDetailNow, handleCreateWorkspace,
  handleSwitchWorkspace, handleRenameWorkspace, handleArchiveWorkspace, handleRestoreWorkspace, openAddItem,
  handleSaveItem, currentDocHeads, handleApplySchema, handleApplyWorkspaceSettings, settingsSaveError,
  handleArchiveItem, handleRestoreItem, undoArchive, handleOpenItemEdit, handleAddSubitem,
  handleStartMove, handleConfirmMove, handleRenameColumn, handleArchiveColumn, addBoardColumn, newBoardColumnArchive, newBoardColumnCollapsible, addingBoardColumn, addBoardColumnError, selectArchiveColumn,
} = app.actions

const rejectionEditor = ref<InstanceType<typeof AutosaveTextarea>>()
async function closeDetail() { if (!rejectionEditor.value || await rejectionEditor.value.flush()) closeDetailNow() }
function openCard(item: Parameters<typeof openBoardItem>[0], event: MouseEvent) { conversations.openCard(item, event) }
function toggleCardTask(item: Parameters<typeof openBoardItem>[0], markdown: string) { void updateItemMarkdown(item, markdown) }

function saveItemDocument(item: { id: string } | null | undefined, document: Omit<DocumentInput, "leadId">) { return item ? submitDocument(item.id, document) : Promise.reject(new Error("Item is no longer open")) }
function saveSelectedLeadDocument(document: Omit<DocumentInput, "leadId">) { return saveItemDocument(selectedLeadItem.value, document) }
const editItemNow = createNarrativeEditHandler(editingFoldSnapshot, activeBoard, leadForItem, () => getActiveDoc()?.entities ?? {}, handleOpenItemEdit)
async function editItem(item: Parameters<typeof editItemNow>[0]) { if (!rejectionEditor.value || await rejectionEditor.value.flush()) editItemNow(item) }

async function applyWorkspaceSettings(payload: Parameters<typeof handleApplyWorkspaceSettings>[0]) { if (await handleApplyWorkspaceSettings(payload)) showSettings.value = false }
const cardAgeFor = useCardAges(() => activeBoard.value?.cardAgingPolicy)
const { memberAvatars, currentAvatar, saveAvatar, avatarNotice } = useMemberAvatars(app.workspace)
</script>

<template>
  <Transition name="startup-cover" @before-enter="showEnteringElement" @before-leave="hideLeavingElement">
    <StartupStatus v-if="startupCoverVisible" expanded :message="startupMessage" :view-only="false" :error="null" />
  </Transition>
  <TincanbanPageLayout :class="{ 'startup-concealed': startupCoverVisible, 'startup-revealed': !startupCoverVisible }" :inert="startupCoverVisible || undefined" :busy="!uiReady && !startupError">
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
        <button class="button button-quiet button-small" type="button" aria-label="Workspace chat" :disabled="!uiReady" @click="chat.open.value = true">Chat<span v-if="chat.unread.value"> · {{ chat.unread.value }}</span></button>
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
        <button class="button button-quiet" type="button" aria-label="Workspace chat" @click="chat.open.value = true">Chat<span v-if="chat.unread.value"> · {{ chat.unread.value }}</span></button>
        <button class="button button-quiet" type="button" @click="openConnections('Participants')">Sync</button>
        <button class="button button-quiet" type="button" aria-label="Settings" @click="showSettings = true">Settings</button>
        <button v-if="canEditBoard" class="button button-quiet" type="button" @click="isEditingBoard = !isEditingBoard">{{ isEditingBoard ? "Done" : "Edit board" }}</button>
        <button v-if="isEditingBoard" class="button button-primary" type="button" @click="showEntitySettings = true">Edit {{ entityName }}</button>
        <a v-if="hasExperimentalMcp" class="button button-quiet agent-guide-desktop" href="/agent">Agent guide</a>
        <input ref="importInput" class="sr-only" type="file" accept=".tincanban,.match,application/vnd.tincanban+zip,application/vnd.match+zip" @change="importWorkspace" />
      </div>
    </template>

    <CausalChangeReview v-if="causalReview.length || causalReviewError" :changes="causalReview" :error="causalReviewError"
      :can-review="uiReady && canEditItems" :review-change="reviewCausalChange"
      :dismiss-change="dismissCausalChange" :restore-change="restoreCausalChange" />

    <section class="toolbar" aria-label="tincanban controls" :inert="!boardVisible || undefined">
      <label class="search-field">
        <span aria-hidden="true">⌕</span>
        <input v-model="search" type="search" aria-label="Search cards" :placeholder="isBlankBoard ? 'Search cards' : 'Search company, role, notes'" />
      </label>
      <div class="toolbar-spacer"></div>
      <LeadFilters v-model="filters" :columns="genericColumns" :fields="boardFields" />
      <div class="toolbar-meta">
        <SaveState :state="saveState" :settled-label="workspacePresenceSummary" aria-label="Workspace presence" />
      </div>
    </section>

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

    <section :key="boardRenderKey" ref="boardRef" class="board" :class="{ 'board-editing': isEditingBoard, 'board-bin-open': visibleColumns.some(column => isArchiveColumn(column) && !isColumnCollapsed(column)), 'board-filtered': hasFilters, 'board-single-column': visibleColumns.length === 1 }" role="region" :aria-label="activeWorkspace.title" @scroll.passive="trackBoardScroll">
      <article
        v-for="column in visibleColumns"
        :key="column.id"
        class="column"
        :data-column-id="column.id"
        :style="{ '--column-hatch-color': columnColor(column.id) }"
        role="region"
        :aria-label="column.title"
        :class="[columnStatus(column.id) ? `column-${columnStatus(column.id)}` : '', { 'bin-column': isArchiveColumn(column), 'bin-column-open': isArchiveColumn(column) && !isColumnCollapsed(column), 'column-foldable': column.collapsible, 'column-collapsed': isColumnCollapsed(column), 'column-moved': movedColumnId === column.id }]"
      >
        <span v-if="column.collapsible" class="column-paper" aria-hidden="true"></span>
        <ColumnFoldCover v-if="column.collapsible" :collapsed="isColumnCollapsed(column)" :title="column.title" :count="itemsForColumn(column).length" />
        <Transition name="column-fold">
          <button v-if="isColumnCollapsed(column)" class="column-closed" type="button" :aria-label="`Open ${column.title} with ${itemsForColumn(column).length} cards`" @click="toggleColumnCollapse(column)"><span class="count">{{ itemsForColumn(column).length }}</span><strong>{{ column.title }}</strong></button>
          <div v-else class="card-stack" :data-column-id="column.id">
            <header class="column-header" :class="{ 'column-drag-handle': isEditingBoard }">
              <div class="column-title"><span class="column-dot"></span><h2 :title="isEditingBoard ? 'Double-click to edit column' : undefined" @dblclick="isEditingBoard && (editingColumn = column)">{{ column.title }}</h2></div>
              <div class="column-actions"><span class="count">{{ itemsForColumn(column).length }}</span><button v-if="column.collapsible && !hasFilters" class="bin-close" type="button" :aria-label="`Collapse ${column.title}`" @click="toggleColumnCollapse(column)">×</button><button v-if="isEditingBoard" class="button button-small button-quiet" type="button" aria-label="Edit column" @click="editingColumn = column">Edit</button></div>
            </header>
            <template v-for="(item, index) in itemsForColumn(column)" :key="item.id">
              <div v-if="index > 0 && !isEditingBoard && canEditItems && !isArchiveColumn(column)" class="card-add-gap"><button class="column-add-button card-insert-button" type="button" :aria-label="`Add ${entityName} between cards in ${column.title}, before ${item.title}`" @click="openAddItem(column.id, item.id)">{{ addItemLabel }}</button></div>
              <BoardItemCard
                :item="item"
                :lead="leadForItem(item)"
                :notes="cardNotes(item)"
                :fields="cardFields(item)"
                :bindings="activeBoard?.preset?.bindings"
                :has-filters="expandFilteredCards || Boolean(cardNoteSearchMatch(item))"
                :show-fields="hasFilters"
                :search-query="cardNoteSearchMatch(item)?.query"
                :search-match-index="cardNoteSearchMatch(item)?.index"
                :can-edit-items="canEditItems"
                :discussion="conversations.cardDiscussions.value.get(item.id)"
                :moved="movedItemId === item.id"
                :age-level="cardAgeFor(item, column)?.level"
                :age-label="cardAgeFor(item, column)?.label"
                @open="openCard"
                @select="openBoardItem"
                @discuss="conversations.openCardDiscussion"
                @task-toggle="toggleCardTask"
              />
            </template>
            <div v-if="!itemsForColumn(column).length" class="empty-column">{{ hasFilters ? 'No matches in this column' : `No ${entityName}s` }}</div>
            <button v-if="!isEditingBoard && canEditItems && !isArchiveColumn(column)" class="column-add-button" type="button" :aria-label="`Add ${entityName} to ${column.title}`" @click="openAddItem(column.id)">{{ addItemLabel }}</button>
          </div>
        </Transition>
      </article>
      <div v-if="hasFilters && !visibleColumns.length" class="board-empty">Try another search or clear filters to see all cards.</div>
      <form v-if="isEditingBoard" class="add-column-card" @submit.prevent="addBoardColumn"><label class="sr-only" for="new-board-column">New column</label><input id="new-board-column" v-model="newBoardColumnTitle" placeholder="New column" :disabled="addingBoardColumn" /><label><input type="checkbox" :checked="newBoardColumnArchive" :disabled="genericColumns.some(column => isArchiveColumn(column)) || addingBoardColumn" @change="selectArchiveColumn(($event.target as HTMLInputElement).checked)" /> Archive column</label><label><input v-model="newBoardColumnCollapsible" type="checkbox" :disabled="addingBoardColumn" /> Allow this column to collapse</label><button class="button button-primary" type="submit" :disabled="addingBoardColumn">{{ addingBoardColumn ? 'Adding…' : '+ Add column' }}</button><p v-if="addBoardColumnError" class="form-error" role="alert">{{ addBoardColumnError }}</p></form>
    </section>

    <BoardDragOverlay :controller="app.board" :filtered="hasFilters" />

    <!-- Dialogs -->
    <WorkspacesDialog
      v-if="showWorkspaces"
      :workspaces="availableWorkspaces" :archived-workspaces="archivedWorkspaces"
      :active-workspace-id="activeWorkspace.id"
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
      mode="templates"
      @close="showSettings = false; settingsSaveError = ''"
      @save-template="handleSaveTemplate"
      @apply-workspace-settings="applyWorkspaceSettings"
    >
      <template #identity>
        <IdentitySettingsPanel :display-name="app.workspace.getCurrentProfile()?.identity.displayName ?? ''" :save-name="(name: string) => saveIdentityName(name, activeWorkspace.id, app.workspace.refreshIdentity)" @recovery="showIdentityRecovery = true" />
        <IdentityPhotoPanel :avatar-data="currentAvatar" :save-avatar="saveAvatar" />
        <p v-if="avatarNotice" role="status">{{ avatarNotice }}</p>
      </template>
      <template #connections>
        <WorkspaceConnectionsPanel :workspace="app.workspace" :workspace-title="activeWorkspace.title" :workspace-id="activeWorkspace.id"
          :controller="app.collaboration.device.blindReplication" :owner="canManageAccess" @open="openConnections" />
      </template>
      <template #publication>
        <PublicBoardControls v-if="uiReady && confirmedRole === 'owner'" :board="activeBoard" :workspace-id="activeWorkspace.id" :document="getActiveDoc()!" :source-version="docVersion" :owner="confirmedRole === 'owner'" />
      </template>
    </SchemaEditorDialog>
    <ModalLayer v-else-if="showSettings" @close="showSettings = false">
      <section class="dialog" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="dialog-head"><div><span class="eyebrow">Identity</span><h2>Settings</h2></div><button class="icon-button" type="button" aria-label="Close" @click="showSettings = false">×</button></div>
        <IdentitySettingsPanel :display-name="app.workspace.getCurrentProfile()?.identity.displayName ?? ''"
          :save-name="(name: string) => saveIdentityName(name, activeWorkspace.id, app.workspace.refreshIdentity)" @recovery="showIdentityRecovery = true" />
        <IdentityPhotoPanel :avatar-data="currentAvatar" :save-avatar="saveAvatar" />
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
      @save-template="handleSaveTemplate"
    />

    <ItemDetailDialog
      v-if="selectedItem"
      :workspace-id="activeWorkspace.id" :item="selectedItem" :columns="genericColumns" :card-stage-buttons="cardStageButtons(activeBoard, genericColumns)"
      :move-to-column="moveCardToColumn" :archived="Boolean(selectedItem && isItemArchived(selectedItem))"
      :narrative="selectedItem ? cardNotes(selectedItem) : ''"
      :read-only="!canEditItems"
      :subitems="subitemsForSelectedItem"
      :fields="boardFields"
      :documents="documentsFor(selectedItem.id)"
      :save-document="(document: Omit<DocumentInput, 'leadId'>) => saveItemDocument(selectedItem, document)"
      :update-document="updateDocumentMarkdown"
      :history="selectedItemHistory"
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
      @update:quick-note="quickNoteDraft = $event"
      @save-note="saveQuickNote(selectedItem)"
      @update-markdown="updateItemMarkdown"
    />

    <ItemFormDialog
      v-if="showItemForm"
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
    <SpatialWindow v-if="selectedLead" framed :window-id="`item:${selectedLead.id}`" :workspace-id="activeWorkspace.id" :title="selectedLead.company" aria-label="Lead details" close-label="Close detail" :initial-width="760" :initial-height="700" @close="closeDetail">
      <template #header><div class="detail-head" :data-discussion-item="selectedLead.id">
          <div><h2 data-discussion-text :data-discussion-field="activeBoard?.preset?.bindings['field.company']">{{ selectedLead.company }}</h2><p data-discussion-text :data-discussion-field="activeBoard?.preset?.bindings['field.role']">{{ selectedLead.role }}</p></div>
          <div class="detail-head-actions">
            <button v-if="selectedLeadItem" class="button button-small" type="button" :disabled="!canEditItems" @click="editItem(selectedLeadItem)">Edit</button>
          </div>
        </div></template>
      <template #toolbar>
      <CardStageStrip v-if="selectedLeadItem" :item="selectedLeadItem" :columns="genericColumns" :buttons="cardStageButtons(activeBoard, genericColumns)" :read-only="!canEditItems" :move="moveCardToColumn" />
      <p v-if="archiveError" class="form-error" role="alert">{{ archiveError }}</p>
      <button v-if="archiveUndo && archiveUndo.workspaceId === activeWorkspace.id" class="button button-small" type="button" :disabled="undoSaving" @click="undoArchive">{{ undoSaving ? 'Restoring…' : 'Undo archive' }}</button>
      </template>
      <section ref="detailDialog" class="detail-layout" data-detail-layout tabindex="-1" :data-discussion-item="selectedLead.id">
        <div class="detail-primary" data-detail-primary role="region" aria-label="Lead description and documents">
          <section v-if="selectedLeadItem && cardNotes(selectedLeadItem)" class="detail-section"><span class="detail-label">Description</span><MarkdownContent class="detail-copy" data-discussion-text data-discussion-field="narrative" :source="cardNotes(selectedLeadItem) || ''" :editable-tasks="canEditItems" @task-toggle="updateItemMarkdown(selectedLeadItem, $event)" /></section>
          <section v-if="selectedLead.sourceText" class="detail-section"><span class="detail-label">Source snapshot</span><p class="source-snapshot" data-discussion-text :data-discussion-field="activeBoard?.preset?.bindings['field.sourceText']">{{ selectedLead.sourceText }}</p></section>
          <section class="detail-section artifacts-section"><div class="section-heading"><div><span class="detail-label">PDF artifacts</span><h3>{{ selectedArtifacts.length ? `${selectedArtifacts.length} attached` : "No generated PDFs" }}</h3></div><button class="button button-small" type="button" :disabled="!canEditItems" @click="showArtifactForm ? showArtifactForm = false : openArtifactForm()">+ PDF</button></div>
            <form v-if="showArtifactForm" class="document-form" novalidate @submit.prevent="submitArtifact"><label><span>Kind</span><select v-model="artifactDraft.kind" @change="artifactDraft.templateId = ''"><option v-for="(label, kind) in artifactKindLabels" :key="kind" :value="kind">{{ label }}</option></select></label><label><span>Title</span><input v-model="artifactDraft.title" placeholder="Cleo CV" /></label><label><span>Base template</span><select v-model="artifactDraft.templateId"><option value="">Select template</option><option v-for="template in availableArtifactTemplates" :key="template.id" :value="template.id">{{ template.name }}</option></select></label><label><span>PDF path</span><input v-model="artifactDraft.pdfPath" placeholder="/Users/…/cleo-cv.pdf" /></label><label><span>Generated Markdown path</span><input v-model="artifactDraft.sourceMarkdownPath" placeholder="/Users/…/cleo-cv.md" /></label><p v-if="artifactError" class="form-error" role="alert">{{ artifactError }}</p><button class="button button-primary" type="submit">Attach PDF</button></form>
            <div v-for="artifact in selectedArtifacts" :key="artifact.id" class="document-row"><span class="document-icon">{{ artifact.kind === "cv" ? "CV" : "CL" }}</span><div><strong>{{ artifact.title }}</strong><span>{{ artifactKindLabels[artifact.kind] }} · from template</span></div><a :href="`file://${artifact.pdfPath}`" class="open-path" title="Open PDF">Open PDF</a></div>
          </section>
          <ItemDocuments v-if="selectedLeadItem" :documents="selectedDocuments" :read-only="!canEditItems" :save="saveSelectedLeadDocument" :update="updateDocumentMarkdown" />
        </div>
        <aside class="detail-inspector" data-detail-inspector aria-label="Lead properties and actions">
        <div class="detail-grid" data-discussion-text data-discussion-field="overview">
          <div><span class="detail-label">Priority</span><strong data-discussion-text :data-discussion-field="activeBoard?.preset?.bindings['field.priority']">{{ selectedLead.priority ? priorityLabels[selectedLead.priority] : "—" }}</strong></div>
          <div><span class="detail-label">Fit</span><strong data-discussion-text :data-discussion-field="activeBoard?.preset?.bindings['field.fitScore']">{{ selectedLead.fitScore ?? "—" }}<small v-if="selectedLead.fitScore !== undefined">/10</small></strong></div>
          <div><span class="detail-label">Location</span><strong data-discussion-text :data-discussion-field="activeBoard?.preset?.bindings['field.location']">{{ selectedLead.location || "—" }}</strong></div>
          <div><span class="detail-label">Work mode</span><strong data-discussion-text :data-discussion-field="activeBoard?.preset?.bindings['field.workMode']">{{ selectedLead.workMode || "—" }}</strong></div>
        </div>
        <a v-if="selectedLead.url" class="source-link" :href="selectedLead.url" target="_blank" rel="noreferrer">Open job source ↗</a>
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
            :save="reason => handleUpdateRejectionReason(activeWorkspace.id, selectedLead!.id, reason)"
            placeholder="Optional rejection reason or retrospective note (what went wrong)…" label="Rejection notes" />
        </section>
        </aside>
      </section>
    </SpatialWindow>
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
      @export="exportWorkspace"
      @dismiss="sync.dismiss"
      @start="sync.startDurableMesh"
      @stop="sync.stopLiveSync"
    />

  </TincanbanPageLayout>
  <BuildFooter />
</template>

<style>
.startup-concealed { visibility: hidden; }
.startup-revealed { animation: startup-reveal 320ms ease-out; }
.startup-cover-enter-active, .startup-cover-leave-active { transition: opacity 320ms ease; }
.startup-cover-enter-from, .startup-cover-leave-to { opacity: 0; }
.startup-cover-leave-active { pointer-events: none; }
@keyframes startup-reveal { from { opacity: 0; } to { opacity: 1; } }
</style>
