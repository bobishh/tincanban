import type { Lead, LeadPriority, LeadStatus } from "../types"
import type { PublicBoardProjection } from "./publicSchema"

export type PublicItem = { id: string; title: string; body: string; values: Record<string, string | number | boolean | null>;
  placement: { parentId: string | null; rank: string }; createdAt: string; updatedAt: string; lastActivityAt?: string }
export type PublicField = { id: string; title: string; valueType: PublicBoardProjection["fields"][number]["valueType"];
  required: boolean; rank: string; options: Record<string, { id: string; title: string; rank: string; archivedAt: null }>; min?: number | null; max?: number | null }
export type PublicColumn = { id: string; title: string; rank: string; color?: string; collapsible?: boolean; items: PublicItem[] }
type PublicBoard = { id: string; title: string; entityName?: string;
  preset?: NonNullable<PublicBoardProjection["board"]["presentation"]>["preset"];
  cardStageButtons?: Array<{ columnId: string; label?: string }>;
  cardAgingPolicy?: NonNullable<PublicBoardProjection["board"]["presentation"]>["cardAgingPolicy"] }

function mapPublicFields(projection: PublicBoardProjection): PublicField[] {
  return projection.fields.map(field => ({ ...field,
    options: Object.fromEntries(field.options.map(option => [option.id, { ...option, archivedAt: null as null }])) }))
}

function mapPublicItems(projection: PublicBoardProjection): PublicItem[] {
  return projection.cards.map(card => ({ id: card.id, title: card.title, body: card.body, values: card.values,
    placement: { parentId: card.parentId ?? card.columnId, rank: card.rank }, createdAt: card.createdAt ?? "", updatedAt: card.updatedAt ?? "",
    ...(card.lastActivityAt ? { lastActivityAt: card.lastActivityAt } : {}) }))
}

function leadBindings(board: PublicBoard, prefix: "field." | "status."): Record<string, string> {
  return Object.fromEntries(Object.entries(board.preset?.bindings ?? {}).flatMap(([key, id]) =>
    key.startsWith(prefix) ? [[id, key.slice(prefix.length)]] : []))
}

function applyLeadValue(lead: Lead, name: string, value: string | number | boolean, fields: PublicField[], fieldId: string): void {
  const selected = fields.find(field => field.id === fieldId)?.options[String(value)]?.title ?? value
  if (["company", "role", "url", "location", "notes", "sourceText", "rejectionReason"].includes(name)) {
    Object.assign(lead, { [name]: String(selected) })
  } else if (name === "fitScore" && Number.isFinite(Number(selected))) lead.fitScore = Number(selected)
  else if (name === "priority" && ["p0", "p1", "p2", "p3"].includes(String(selected))) lead.priority = String(selected) as LeadPriority
  else if (name === "workMode" && ["remote", "hybrid", "onsite", "unknown"].includes(String(selected))) lead.workMode = String(selected) as Lead["workMode"]
}

function publicLead(item: PublicItem, fields: PublicField[], fieldNames: Record<string, string>, statuses: Record<string, string>): Lead {
  const [company, ...role] = item.title.split(" — ")
  const lead: Lead = { id: item.id, company: company ?? item.title, role: role.join(" — "),
    status: (statuses[item.placement.parentId ?? ""] as LeadStatus | undefined) ?? "lead",
    description: item.body, createdAt: item.createdAt, updatedAt: item.updatedAt }
  for (const [fieldId, value] of Object.entries(item.values)) {
    const name = fieldNames[fieldId]
    if (name && value !== null) applyLeadValue(lead, name, value, fields, fieldId)
  }
  return lead
}

function projectPublicLeads(board: PublicBoard, items: PublicItem[], fields: PublicField[]): Map<string, Lead> {
  if (board.preset?.key !== "job-search") return new Map()
  const fieldNames = leadBindings(board, "field.")
  const statuses = leadBindings(board, "status.")
  return new Map(items.map(item => [item.id, publicLead(item, fields, fieldNames, statuses)]))
}

// This visitor projection intentionally uses local display records. It must not construct or import the private workspace model.
export function publicBoardView(projection: PublicBoardProjection) {
  const board: PublicBoard = { id: projection.board.id, title: projection.board.title, ...projection.board.presentation }
  const fields = mapPublicFields(projection)
  const items = mapPublicItems(projection)
  const columns: PublicColumn[] = projection.columns.map(column => ({ ...column,
    items: items.filter(item => item.placement.parentId === column.id) }))
  return { board, columns, fields, items, leads: projectPublicLeads(board, items, fields) }
}
