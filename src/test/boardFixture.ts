import templates from "./fixtures/board-templates.json" with { type: "json" }
import { createWorkspaceDoc as create, seedBoard as seed, type BoardTemplate } from "../domain/seeds"
export type { WorkspaceCreationDraft } from "../domain/seeds"
export function createWorkspaceDoc(id: string, title: string, owner: string, key: string, now?: string) {
  return create(id, title, owner, key, now, (templates as Record<string, unknown>)[key] as BoardTemplate)
}
export function seedBoard(entities: Parameters<typeof seed>[0], title: string, key: string, now?: string) {
  return seed(entities, title, key, now, (templates as Record<string, unknown>)[key] as BoardTemplate)
}
