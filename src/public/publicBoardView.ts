import type { Board, Column, FieldDefinition, Item } from "../domain/model"
import { leadPresentationBindings, presentLead } from "../domain/leadPresentation"
import type { Lead } from "../types"
import type { PublicBoardProjection } from "./publicSchema"

export type PublicItem = Item
export type PublicField = FieldDefinition & { rank: string; options: Record<string, { id: string; title: string; rank: string; archivedAt: null }> }
export type PublicColumn = Column & { rank: string; items: PublicItem[] }

function displayBase(id: string, title: string, parentId: string | null, rank: string) {
  return { id, title, placement: { parentId, rank }, archivedAt: null, createdAt: "", updatedAt: "" }
}

function mapPublicFields(projection: PublicBoardProjection): PublicField[] {
  return projection.fields.map(field => {
    const base = { ...displayBase(field.id, field.title, projection.board.id, field.rank), kind: "field" as const,
      required: field.required, rank: field.rank,
      options: Object.fromEntries(field.options.map(option => [option.id, { ...option, archivedAt: null }])) }
    if (field.valueType === "number") return { ...base, valueType: field.valueType, min: field.min ?? null, max: field.max ?? null }
    return { ...base, valueType: field.valueType }
  })
}

function mapPublicItems(projection: PublicBoardProjection): PublicItem[] {
  return projection.cards.map(card => ({ ...displayBase(card.id, card.title, card.parentId ?? card.columnId, card.rank),
    body: card.body, values: card.values, createdAt: card.createdAt ?? "", updatedAt: card.updatedAt ?? "",
    ...(card.lastActivityAt ? { lastActivityAt: card.lastActivityAt } : {}) }))
}

function projectPublicLeads(board: Board, items: PublicItem[], projection: PublicBoardProjection): Map<string, Lead> {
  if (board.preset?.key !== "job-search") return new Map()
  const bindings = leadPresentationBindings(board.preset.bindings)
  const columns = new Map(projection.cards.map(card => [card.id, card.columnId]))
  return new Map(items.map(item => [item.id, presentLead(item, bindings.columnStatuses[columns.get(item.id) ?? ""] ?? "lead", bindings)]))
}

// Display records contain only published data. They carry no workspace, identity, grant or write capability.
export function publicBoardView(projection: PublicBoardProjection) {
  const board: Board = { ...displayBase(projection.board.id, projection.board.title, null, "0/1"),
    kind: "board", preset: null, ...projection.board.presentation }
  const fields = mapPublicFields(projection)
  const items = mapPublicItems(projection)
  const columns: PublicColumn[] = projection.columns.map(column => ({
    ...displayBase(column.id, column.title, board.id, column.rank), kind: "column", ...column,
    items: items.filter(item => item.placement.parentId === column.id) }))
  return { board, columns, fields, items, leads: projectPublicLeads(board, items, projection) }
}
