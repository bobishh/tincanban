import type { WorkspaceDocumentV2 } from "../domain/model"
import { createPublicBoardPublication, type PublicAssetStager, type PublicProjectionPorts } from "../public/publicProjection"

/** Browser adapters stay outside the portable projection used by automation. */
export async function createBrowserBoardPublication(document: WorkspaceDocumentV2, workspaceId: string, boardId: string,
  stageAsset?: PublicAssetStager, provided: PublicProjectionPorts = {}) {
  const chat = provided.chat ?? await loadChat(workspaceId)
  const readFile = provided.readFile ?? (await import("../attachments")).readAttachment
  return createPublicBoardPublication(document, workspaceId, boardId, stageAsset, { chat, readFile })
}

async function loadChat(workspaceId: string) {
  const service = await import("../chat/service")
  const scope = await service.getChatScope(workspaceId)
  const chat = await service.loadChat(workspaceId)
  return { scope, messages: chat.messages, profiles: chat.profiles }
}
