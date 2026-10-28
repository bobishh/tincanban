import type { FieldDefinition, Item } from "../domain/model"
import type { Anchor } from "./context"

type ReferenceKind = "Card" | "Description" | "Field"
export type ReferenceChoice = { title: string; anchor: Anchor; type?: ReferenceKind; searchText?: string }

export function itemReferenceChoices(items: readonly Item[], fields: readonly FieldDefinition[], workspaceScope: string, boardId: string, narrativeFieldId?: string): ReferenceChoice[] {
  return items.flatMap(item => {
    const anchor: Anchor = { workspaceScope, boardId, itemId: item.id }
    const choices: ReferenceChoice[] = [{ title: item.title, anchor, type: "Card" }]
    const narrative = item.body || (narrativeFieldId ? String(item.values[narrativeFieldId] ?? "") : "")
    if (narrative.trim()) choices.push({ title: `${item.title} · Description`, anchor: { ...anchor, fieldId: "narrative" }, type: "Description", searchText: narrative })
    for (const field of fields) {
      if (field.id === narrativeFieldId) continue
      const value = item.values[field.id]
      if (value === undefined || value === null || value === "") continue
      choices.push({ title: `${item.title} · ${field.title}`, anchor: { ...anchor, fieldId: field.id }, type: "Field", searchText: String(value) })
    }
    return choices
  })
}
