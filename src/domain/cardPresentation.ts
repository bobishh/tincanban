import type { Board, FieldDefinition, FieldValue, Item } from "./entitySchemas"

export function cardTitle(board: Board | null | undefined, values: Record<string, FieldValue>, fallback: string): string {
  const parts = (board?.cardPresentation?.titleFieldIds ?? []).flatMap(id => {
    const value = values[id]
    return typeof value === "string" && value.trim() ? [value.trim()] : []
  })
  return parts.join(" — ") || fallback
}

export function narrativeFieldId(board: Board | null | undefined, fields: FieldDefinition[]): string | undefined {
  const id = board?.cardPresentation?.narrativeFieldId
  return fields.some(field => field.id === id && field.valueType === "text" && !field.archivedAt) ? id : undefined
}

export function displayFieldValue(field: FieldDefinition, value: FieldValue | undefined): string {
  if (value === undefined || value === null) return ""
  if (field.valueType === "select") return field.options[String(value)]?.title ?? String(value)
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return String(value)
}

export function configuredCardFields(item: Item, fields: FieldDefinition[], ids?: string[]) {
  const selected = ids ? ids.flatMap(id => fields.find(field => field.id === id) ?? []) : fields
  return selected.flatMap(field => {
    if (field.archivedAt) return []
    const value = displayFieldValue(field, item.values[field.id])
    return value ? [{ id: field.id, title: field.title, value }] : []
  })
}
