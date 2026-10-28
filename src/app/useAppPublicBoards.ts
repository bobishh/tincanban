import { computed, nextTick, type Ref } from "vue"
import { hasEntityKind, type Board } from "../domain/model"
import type { useAppController } from "./useAppController"
import { usePublicBoardAccess } from "./usePublicBoardAccess"
import { usePublicBoardDelivery } from "./usePublicBoardDelivery"
import { usePublicBoardDeliveryCoordinator } from "./usePublicBoardDeliveryCoordinator"

export function useAppPublicBoards(app: ReturnType<typeof useAppController>, uiReady: Ref<boolean>) {
  const { activeBoard, activeWorkspace, getActiveDoc, docVersion, availableWorkspaces } = app.workspace
  const { currentDocHeads } = app.actions
  const { confirmedRole } = app.collaboration.permissions
  const connections = app.collaboration.device.blindReplication.configs
  const originsFor = (workspaceId: string) => [...new Set(connections.value
    .filter(connection => connection.workspaceId === workspaceId && !connection.removalPending)
    .map(connection => connection.origin))]
  const originFor = (workspaceId: string, board: Board | null | undefined) => {
    const origins = originsFor(workspaceId)
    return board?.publicationOrigin ?? (origins.length === 1 ? origins[0]! : "")
  }
  const origin = computed(() => originFor(activeWorkspace.id, activeBoard.value))
  const connected = () => Boolean(origin.value) && originsFor(activeWorkspace.id).includes(origin.value)
  const publicAccess = usePublicBoardAccess({
    origin: () => origin.value,
    connected,
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
    origin: () => connected() ? origin.value : "",
    workspaceId: () => activeWorkspace.id,
    boardId: () => activeBoard.value?.id,
    document: getActiveDoc,
    sourceVersion: () => docVersion.value,
    sourceHeads: () => currentDocHeads.value,
    role: () => uiReady.value ? confirmedRole.value : null,
    recoveryActive: () => app.collaboration.device.sync.isOpen.value,
    profile: app.workspace.getCurrentProfile,
  })
  const backgroundPublicDelivery = usePublicBoardDeliveryCoordinator({
    origin: (workspaceId, boardId, document) => {
      const board = document.entities[boardId]
      return originFor(workspaceId, hasEntityKind(board, "board") ? board : null)
    },
    connected: (workspaceId, server) => originsFor(workspaceId).includes(server),
    ready: () => uiReady.value,
    workspaceIds: () => availableWorkspaces.value.map(workspace => workspace.id),
    activeBoard: () => ({ workspaceId: activeWorkspace.id, boardId: activeBoard.value?.id ?? "" }),
    profile: app.workspace.getCurrentProfile,
    readWorkspaceDoc: app.workspace.readWorkspaceDoc,
    subscribeLocalChanges: app.workspace.subscribeLocalChanges,
  })
  const access = { ...publicAccess,
    origins: computed(() => [...new Set([origin.value, ...originsFor(activeWorkspace.id)].filter(Boolean))]),
    async selectOrigin(server: string) {
      if (!publicAccess.owner.value || publicAccess.busy.value || publicAccess.published.value ||
          origin.value && !publicAccess.privateConfirmed.value) throw new Error("Disable public access before changing its Rusty server.")
      if (!originsFor(activeWorkspace.id).includes(server)) throw new Error("Connect this board to the selected Rusty first.")
      if (activeBoard.value?.publicationOrigin !== server) {
        await app.workspace.executeCommandAsync({ kind: "setBoardPublicationOrigin", boardId: activeBoard.value!.id, origin: server })
      }
    },
    async setPublic(enabled: boolean) {
      const server = origin.value, board = activeBoard.value
      if (enabled) {
        if (!board || !connected()) throw new Error("Connect Rusty to this board to enable public access.")
        if (board.publicationOrigin !== server) {
          await app.workspace.executeCommandAsync({ kind: "setBoardPublicationOrigin", boardId: board.id, origin: server })
          await nextTick()
        }
        if (activeBoard.value?.id !== board.id || origin.value !== server || !connected()) throw new Error("Board publication connection changed; retry the action")
      }
      await publicAccess.setPublic(enabled)
    },
  }
  return { publicAccess: access, publicDelivery, backgroundPublicDelivery }
}
