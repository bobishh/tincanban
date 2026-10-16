import { computed, type Ref } from "vue"
import type { useAppController } from "./useAppController"
import { usePublicBoardAccess } from "./usePublicBoardAccess"
import { usePublicBoardDelivery } from "./usePublicBoardDelivery"
import { usePublicBoardDeliveryCoordinator } from "./usePublicBoardDeliveryCoordinator"

export function useAppPublicBoards(app: ReturnType<typeof useAppController>, uiReady: Ref<boolean>) {
  const { activeBoard, activeWorkspace, getActiveDoc, docVersion, availableWorkspaces } = app.workspace
  const { currentDocHeads } = app.actions
  const { confirmedRole } = app.collaboration.permissions
  const publicAccess = usePublicBoardAccess({
    origin: ((import.meta.env.VITE_PUBLIC_BOARD_ORIGIN as string | undefined) ?? "").trim(),
    boardId: () => activeBoard.value?.id,
    boardTitle: () => activeBoard.value?.title ?? "",
    workspaceId: () => activeWorkspace.id,
    document: getActiveDoc,
    sourceVersion: () => docVersion.value,
    sourceHeads: () => currentDocHeads.value,
    owner: () => uiReady.value && confirmedRole.value === "owner",
    profile: app.workspace.getCurrentProfile,
  })
  const publicDelivery = usePublicBoardDelivery({
    origin: ((import.meta.env.VITE_PUBLIC_BOARD_ORIGIN as string | undefined) ?? "").trim(),
    workspaceId: () => activeWorkspace.id,
    boardId: () => activeBoard.value?.id,
    document: getActiveDoc,
    sourceVersion: () => docVersion.value,
    sourceHeads: () => currentDocHeads.value,
    role: () => uiReady.value ? confirmedRole.value : null,
    profile: app.workspace.getCurrentProfile,
  })
  const backgroundPublicDelivery = usePublicBoardDeliveryCoordinator({
    origin: ((import.meta.env.VITE_PUBLIC_BOARD_ORIGIN as string | undefined) ?? "").trim(),
    ready: () => uiReady.value,
    workspaceIds: () => availableWorkspaces.value.map(workspace => workspace.id),
    activeBoard: () => ({ workspaceId: activeWorkspace.id, boardId: activeBoard.value?.id ?? "" }),
    profile: app.workspace.getCurrentProfile,
    readWorkspaceDoc: app.workspace.readWorkspaceDoc,
    subscribeLocalChanges: app.workspace.subscribeLocalChanges,
  })
  const backgroundPublicDeliveryError = computed(() => backgroundPublicDelivery.errors.value[activeWorkspace.id] ||
    backgroundPublicDelivery.status.value.find(delivery => delivery.workspaceId === activeWorkspace.id && delivery.error)?.error || "")

  return { publicAccess, publicDelivery, backgroundPublicDeliveryError }
}
