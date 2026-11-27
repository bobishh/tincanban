import type { Doc } from "@automerge/automerge/slim"
import type { LocalProfile } from "./domain/identity"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { needsWorkspaceStateMigration } from "./domain/workspaceMigration"
import { workspaceRole } from "./sync/changeAuthorization"

export async function migrateOwnedWorkspace(doc: Doc<WorkspaceDocumentV2>, profile: LocalProfile | null,
  persistMigration: (doc: Doc<WorkspaceDocumentV2>, profile: LocalProfile) => Promise<Doc<WorkspaceDocumentV2>>): Promise<Doc<WorkspaceDocumentV2>> {
  if (!profile) return doc
  if ((doc as { formatVersion: number }).formatVersion !== 2 && !needsWorkspaceStateMigration(doc)) return doc
  return await workspaceRole(doc, profile) === "owner" ? persistMigration(doc, profile) : doc
}
