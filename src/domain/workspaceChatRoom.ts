import { hasEntityKind, type WorkspaceDocumentV2 } from "./model"

export function workspaceChatRoomId(doc: WorkspaceDocumentV2): string {
  const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))
  if (!board) throw new Error("Workspace has no board")
  return `${doc.ownerPersonId}:${board.id}`
}
