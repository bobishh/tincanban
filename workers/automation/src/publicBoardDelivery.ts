import type { WorkspaceDocumentV2 } from "../../../src/domain/model";
import { createPublicBoardPublication, snapshotPublicBoardSource } from "../../../src/public/publicProjection";
import type { PublicBoardProjection } from "../../../src/public/publicSchema";

/** Automation cannot author files or discussions; retain their confirmed, coherent public manifest. */
export async function automationPublicProjection(document: WorkspaceDocumentV2, workspaceId: string, boardId: string,
  current: PublicBoardProjection): Promise<PublicBoardProjection> {
  const source = snapshotPublicBoardSource(document, boardId);
  const { projection } = await createPublicBoardPublication(source, workspaceId, boardId, undefined,
    { retainedContent: current });
  // These belong to the exact CAS revision read by publicDelivery, never a parallel stale cache.
  return projection;
}
