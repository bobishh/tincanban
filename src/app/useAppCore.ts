import { computed, ref, watch } from "vue"
import { workspaceRole, effectiveWorkspaceOwner, exportAuthorizationBundle } from "../sync/changeAuthorization"
import { canWorkspace, type WorkspaceRole } from "../domain/permissions"
import { bootstrapIdentity } from "../domain/identity"
import { useTincanban } from "../state"
import type { ArtifactKind } from "../types"
import { type Column, type Item } from "../domain/model"
import { configureChat, exportChat, receiveChat, subscribeChat } from "../chat/service"
import type { WorkspaceAccessResult } from "./workspaceAccessState"
import { refreshWorkspaceAccess } from "./workspaceAccessRefresh"
import type { AppStartupStage } from "./startup"
import { useWorkspaceChat } from "../chat/useWorkspaceChat"
import { defaultBoardFilters, type BoardFilters } from "../filters"
import { useBlindReplication } from "../sync/useBlindReplication"
import { useDeviceSync } from "../sync/useDeviceSync"
import { meshTrace } from "../sync/meshTrace"
import { useAppMesh } from "./useAppMesh"
import { configureAttachmentFetcher, readStoredAttachment, writeStoredAttachment } from "../attachments"
import { workspaceBlobDescriptor, workspaceChatRoomId } from "./workspaceMetadata"

type ArchiveUndo = { workspaceId: string; itemId: string; title: string }

export function useAppCore() {
  const tincanban = useTincanban()
  const ui = useAppUiState()
  const collaboration = useAppCollaboration(tincanban, ui)
  const drafts = useAppDrafts()
  return { tincanban, ...ui, ...collaboration, ...drafts }
}

function useAppUiState() {
  const selectedLeadId = ref<string | null>(null)
  const detailDialog = ref<HTMLElement | null>(null)
  const importInput = ref<HTMLInputElement | null>(null)
  const showArtifactForm = ref(false)
  const search = ref("")
  const filters = ref<BoardFilters>(defaultBoardFilters())
  const notice = ref("")
  const archiveUndo = ref<ArchiveUndo | null>(null)
  const undoSaving = ref(false)
  const archiveError = ref("")
  const historyRestoreSaving = ref(false)
  const historyRestoreError = ref("")
  const historyRestoreNotice = ref("")
  const isArchiveOpen = ref(false)
  const artifactError = ref("")
  const showWorkspaces = ref(false)
  const showEntitySettings = ref(false)
  const isEditingBoard = ref(false)
  const newBoardColumnTitle = ref("")
  const boardRef = ref<HTMLElement | null>(null)
  const boardRenderKey = ref(0)
  const movedItemId = ref<string | null>(null)
  const movedColumnId = ref<string | null>(null)
  const showItemForm = ref(false)
  const itemFormParentId = ref("")
  const itemFormError = ref("")
  const savingItem = ref(false)
  const editingColumn = ref<Column | null>(null)
  const selectedItemId = ref<string | null>(null)
  const editingItemId = ref<string | null>(null)
  const itemToMove = ref<Item | null>(null)
  const showMoveDialog = ref(false)
  const storageError = ref("")
  const quickNoteDraft = ref("")
  const quickNoteSaving = ref(false)
  const quickNoteError = ref("")
  const hasExperimentalMcp = ref(false)
  const showMobileMenu = ref(false)
  const menuButtonRef = ref<HTMLButtonElement | null>(null)
  const startupError = ref<{ stage: AppStartupStage; message: string; detail: string } | null>(null)
  const toggleMobileMenu = () => { showMobileMenu.value = !showMobileMenu.value }
  const closeMobileMenu = () => { showMobileMenu.value = false }
  return {
    selectedLeadId, detailDialog, importInput, showArtifactForm, search, filters, notice,
    archiveUndo, undoSaving, archiveError, historyRestoreSaving, historyRestoreError, historyRestoreNotice,
    isArchiveOpen, artifactError, showWorkspaces, showEntitySettings, isEditingBoard,
    newBoardColumnTitle, boardRef, boardRenderKey, movedItemId, movedColumnId,
    showItemForm, itemFormParentId, itemFormError, savingItem, editingColumn, selectedItemId, editingItemId,
    itemToMove, showMoveDialog, storageError, quickNoteDraft, quickNoteSaving, quickNoteError,
    hasExperimentalMcp, showMobileMenu, menuButtonRef, startupError, toggleMobileMenu, closeMobileMenu,
  }
}

function useAppDrafts() {
  const artifactDraft = ref({ kind: "cv" as ArtifactKind, title: "", templateId: "", pdfPath: "", sourceMarkdownPath: "" })
  return { artifactDraft }
}

function useAppCollaboration(tincanban: ReturnType<typeof useTincanban>, ui: ReturnType<typeof useAppUiState>) {
  configureChat(
    async id => (await tincanban.readWorkspaceDoc(id)).ownerPersonId,
    async id => workspaceChatRoomId(await tincanban.readWorkspaceDoc(id)),
  )
  const chatWorkspaceId = computed(() => tincanban.ready.value ? tincanban.activeWorkspace.id : "")
  const chatOwnerId = computed(() => { void tincanban.docVersion.value; return tincanban.getActiveDoc()?.ownerPersonId ?? "" })
  const identityName = computed(() => { void tincanban.docVersion.value; return tincanban.getCurrentProfile()?.identity.displayName ?? "" })
  const chat = useWorkspaceChat(chatWorkspaceId, chatOwnerId, identityName)
  const sync = useDeviceSync({
    displayName: () => identityName.value,
    identityChanged: tincanban.refreshIdentity,
    workspace: {
      subscribe: listener => subscribeWorkspaceAndChat(tincanban.subscribeLocalChanges, listener),
      subscribeWorkspace: listener => subscribeWorkspaceAndChatScoped(tincanban.subscribeLocalChanges, listener),
    },
    workspaceStore: {
      read: id => timedWorkspaceStoreStage("read", id, () => tincanban.readWorkspaceBytes(id)),
      readAuthorityHeads: id => timedWorkspaceStoreStage("authority-heads", id, () => tincanban.readWorkspaceHeads(id)),
      reclassify: id => timedWorkspaceStoreStage("reclassify", id, () => tincanban.reclassifyWorkspace(id)),
      validate: (id, bytes, authorization) => timedWorkspaceStoreStage("validate", id, async () => {
        await tincanban.validateAuthorizedWorkspace(id, bytes, authorization)
      }),
      merge: (id, bytes, authorization) => timedWorkspaceStoreStage("merge", id, () =>
        tincanban.mergeAuthorizedWorkspace(id, bytes, authorization)),
      recordVerifiedOwnerWorkspace: id => tincanban.recordVerifiedOwnerWorkspace(id),
      readAuthorization: (bytes, id) => timedWorkspaceStoreStage("read-authorization", id ?? "unknown", () =>
        // The exchanged bytes include quarantined history; export proofs for that raw evidence.
        exportAuthorizationBundle(bytes)),
      activate: tincanban.switchWorkspace,
      readChat: exportChat,
      mergeChat: receiveChat,
      blob: {
        resolve: async (workspaceId, blobId) => workspaceBlobDescriptor(await tincanban.readWorkspaceDoc(workspaceId), blobId),
        read: readStoredAttachment,
        write: writeStoredAttachment,
      },
    },
    origin: () => window.location.origin,
    availableWorkspaces: tincanban.availableWorkspaces,
    activeWorkspaceId: () => tincanban.activeWorkspace.id || "default",
    workspaceOwner: id => timedWorkspaceStoreStage("owner-check", id, () =>
      resolveWorkspaceOwner(tincanban.readWorkspaceDoc, id)),
  })
  configureAttachmentFetcher(descriptor => sync.fetchBlob(tincanban.activeWorkspace.id, descriptor))
  const policy = useWorkspacePolicy(tincanban, ui, sync)
  const blindReplication = useBlindReplication(tincanban)
  const mesh = useAppMesh({ activeWorkspace: tincanban.activeWorkspace, chat, sync, blindReplication, ...policy })
  return { chat, sync, blindReplication, ...policy, ...mesh }
}

function subscribeWorkspaceAndChat(subscribeLocalChanges: ReturnType<typeof useTincanban>["subscribeLocalChanges"], listener: () => void) {
  const stopWorkspace = subscribeLocalChanges(listener)
  const stopChat = subscribeChat(listener)
  return () => { stopWorkspace(); stopChat() }
}

function subscribeWorkspaceAndChatScoped(
  subscribeLocalChanges: ReturnType<typeof useTincanban>["subscribeLocalChanges"],
  listener: (workspaceId?: string) => void,
) {
  const stopWorkspace = subscribeLocalChanges(listener)
  const stopChat = subscribeChat(event => listener(event.workspaceId))
  return () => { stopWorkspace(); stopChat() }
}

async function timedWorkspaceStoreStage<T>(stage: string, workspaceId: string, operation: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try { return await operation() }
  finally {
    const elapsedMs = Math.round(performance.now() - started)
    if (elapsedMs >= 1_000) meshTrace("workspace.store.slow", {
      stage, workspaceId: workspaceId, elapsedMs,
    }, "warn")
  }
}

async function resolveWorkspaceOwner(readWorkspaceDoc: ReturnType<typeof useTincanban>["readWorkspaceDoc"], id: string) {
  const doc = await readWorkspaceDoc(id)
  await workspaceRole(doc, await bootstrapIdentity("My Device"))
  return effectiveWorkspaceOwner(id, doc.ownerPersonId)
}

function useWorkspacePolicy(tincanban: ReturnType<typeof useTincanban>, ui: ReturnType<typeof useAppUiState>, sync: ReturnType<typeof useDeviceSync>) {
  const currentRole = ref<WorkspaceRole>("visitor")
  const roleWorkspaceId = ref("")
  const currentWorkspaceOwnerId = ref("")
  const workspaceAccess = ref<Record<string, WorkspaceAccessResult>>({})
  const workspaceAccessErrors = ref<string[]>([])
  const workspaceRoleStatus = computed(() => roleWorkspaceId.value !== tincanban.activeWorkspace.id ? "loading" : workspaceAccess.value[tincanban.activeWorkspace.id]?.error ? "unavailable" : "verified")
  const confirmedRole = computed(() => tincanban.ready.value && workspaceRoleStatus.value === "verified" ? currentRole.value : null)
  const refreshAccess = async (includeOthers: boolean, onCleanup: (cleanup: () => void) => void) => {
    if (!tincanban.ready.value) return
    let cancelled = false
    onCleanup(() => { cancelled = true })
    const doc = tincanban.getActiveDoc()
    if (!doc) return
    await refreshWorkspaceAccess({ workspaceId: doc.id, includeOthers, cancelled: () => cancelled,
      getActiveWorkspaceId: () => tincanban.activeWorkspace.id, getDocVersion: () => tincanban.docVersion.value,
      getWorkspaceIds: () => tincanban.availableWorkspaces.value.map(item => item.id),
      load: async (all, onActive) => {
        const { loadWorkspaceAccess } = await import("./workspaceAccessLoader")
        return loadWorkspaceAccess(tincanban, doc, sync, all, onActive)
      },
      state: { currentRole, currentWorkspaceOwnerId, roleWorkspaceId, workspaceAccess, workspaceAccessErrors } })
  }
  const identityFingerprint = () => {
    void tincanban.docVersion.value
    const profile = tincanban.getCurrentProfile()
    return profile ? `${profile.identity.personId}|${profile.identity.publicKey}|${profile.device.deviceId}|${profile.certificate.signature}` : ""
  }
  watch([() => tincanban.activeWorkspace.id, () => tincanban.availableWorkspaces.value.map(item => item.id).join("|"), () => tincanban.ready.value, sync.ownershipRevision, identityFingerprint],
    (_, __, onCleanup) => refreshAccess(true, onCleanup), { immediate: true })
  watch(tincanban.docVersion, (_, __, onCleanup) => refreshAccess(false, onCleanup))
  const activePolicyAvailable = computed(() => tincanban.ready.value && roleWorkspaceId.value === tincanban.activeWorkspace.id && workspaceAccess.value[tincanban.activeWorkspace.id]?.blocked !== true && !sync.isWorkspaceAccessRevoked(tincanban.activeWorkspace.id) && !sync.meshSuccession.value.find(item => item.workspaceId === tincanban.activeWorkspace.id)?.conflicted)
  const allowed = (permission: Parameters<typeof canWorkspace>[1]) => computed(() => activePolicyAvailable.value && canWorkspace(currentRole.value, permission))
  const canEditItems = allowed("content.write")
  const canEditBoard = allowed("board.configure")
  const canManageAccess = allowed("access.manage")
  const canImportWorkspace = allowed("workspace.import")
  const keeperOwnedWorkspaces = computed(() => tincanban.availableWorkspaces.value.filter(item => {
    const access = workspaceAccess.value[item.id]
    return access?.role === "owner" && !access.blocked && !access.error
  }))
  const canRenameWorkspace = (id: string) => {
    const access = workspaceAccess.value[id]
    return Boolean(access && !access.blocked && canWorkspace(access.role, "workspace.rename"))
  }
  watch(canEditBoard, allowed => { if (!allowed) { ui.isEditingBoard.value = false; ui.editingColumn.value = null; ui.showEntitySettings.value = false } })
  watch(canEditItems, allowed => { if (!allowed) closeRestrictedEditors(ui) })
  return { confirmedRole, currentRole, currentWorkspaceOwnerId, workspaceAccess, workspaceAccessErrors, workspaceRoleStatus, keeperOwnedWorkspaces, canEditItems, canEditBoard, canManageAccess, canImportWorkspace, canRenameWorkspace }
}

function closeRestrictedEditors(ui: ReturnType<typeof useAppUiState>) {
  ui.showItemForm.value = false
  ui.editingItemId.value = null
  ui.showArtifactForm.value = false
  ui.showMoveDialog.value = false
  ui.itemToMove.value = null
}
