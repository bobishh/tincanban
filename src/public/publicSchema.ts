import { z } from "zod"
import { textFormatSchema, cardPresentationSchema, cardAgingPolicySchema } from "../domain/entitySchemas"
import { isValidRank } from "../domain/rank"

const MAX_PROJECTION_BYTES = 2 * 1024 * 1024
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const i128Max = (1n << 127n) - 1n
const i128Min = -(1n << 127n)
const rank = z.string().max(128).refine(value => isValidRank(value) && validI128Rank(value))
const optionSchema = z.strictObject({ id, title: z.string().max(4096), rank })
const columnSchema = z.strictObject({ id, title: z.string().max(4096), rank, color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), archive: z.literal(true).optional(), collapsible: z.boolean().optional() })
const fieldSchema = z.strictObject({ id, title: z.string().max(4096), valueType: z.enum(["text", "url", "date", "datetime", "boolean", "number", "select"]), format: textFormatSchema.optional(), required: z.boolean(), rank, options: z.array(optionSchema).max(200), min: z.number().finite().nullable().optional(), max: z.number().finite().nullable().optional() })
const scalar = z.union([z.string().max(200_000), z.number().finite(), z.boolean(), z.null()])
const cardSchema = z.strictObject({ id, parentId: id.nullable(), columnId: id, title: z.string().max(4096), body: z.string().max(200_000), values: z.record(id, scalar), rank, createdAt: z.string().max(128).optional(), updatedAt: z.string().max(128).optional(), lastActivityAt: z.string().max(128).optional() })
const discussionTargetSchema = z.strictObject({ type: z.enum(["board", "card", "field"]), id, cardId: id.optional() })
const discussionSchema = z.strictObject({ id, threadId: id, replyTo: id.nullable(), targets: z.array(discussionTargetSchema).min(1).max(8), author: z.string().max(500), createdAt: z.string().max(128), body: z.string().max(8000) })
const fileSchema = z.strictObject({ id, parentId: id, title: z.string().max(4096), fileName: z.string().max(512), mediaType: z.string().max(256), byteLength: z.number().int().nonnegative().max(16 * 1024 * 1024), sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
const presentationSchema = z.strictObject({
  entityName: z.string().min(1).max(100).optional(),
  archiveColumnId: id.nullable().optional(),
  preset: z.strictObject({ key: z.string().min(1), version: z.literal(1), bindings: z.record(z.string().max(128), id) }).nullable().optional(),
  cardStageButtons: z.array(z.strictObject({ columnId: id, label: z.string().min(1).max(4096).optional() })).max(100).optional(),
  cardAgingPolicy: cardAgingPolicySchema.optional(),
  cardPresentation: cardPresentationSchema.optional(),
})
export const publicBoardProjectionSchema = z.strictObject({
  kind: z.literal("tincanban-public-board"), version: z.literal(1), board: z.strictObject({ id, title: z.string().max(4096), presentation: presentationSchema.optional() }),
  columns: z.array(columnSchema).max(100), fields: z.array(fieldSchema).max(200), cards: z.array(cardSchema).max(5000),
  discussions: z.array(discussionSchema).max(2000), files: z.array(fileSchema).max(500),
}).superRefine(validateProjection)

function validateProjection(p: PublicBoardProjection, ctx: z.RefinementCtx): void {
  const cards = new Map(p.cards.map(card => [card.id, card]))
  const fields = new Set(p.fields.map(field => field.id))
  validateUniqueIdentifiers(p, ctx)
  validatePresentationBindings(p, ctx)
  validateArchiveColumn(p, ctx)
  validateCards(p, cards, ctx)
  validateDiscussions(p, cards, fields, ctx)
  validateFiles(p, cards, ctx)
  validateFieldOptions(p, ctx)
}

function validateUniqueIdentifiers(p: PublicBoardProjection, ctx: z.RefinementCtx): void {
  const ids = [p.board.id, ...p.columns.map(x => x.id), ...p.fields.map(x => x.id), ...p.fields.flatMap(x => x.options.map(o => o.id)), ...p.cards.map(x => x.id), ...p.discussions.map(x => x.id), ...p.files.map(x => x.id)]
  if (new Set(ids).size !== ids.length) issue(ctx, "Public identifiers must be unique")
}

function validatePresentationBindings(p: PublicBoardProjection, ctx: z.RefinementCtx): void {
  const visibleIds = new Set([...p.columns.map(column => column.id), ...p.fields.map(field => field.id), ...p.fields.flatMap(field => field.options.map(option => option.id))])
  if (Object.values(p.board.presentation?.preset?.bindings ?? {}).some(id => !visibleIds.has(id))) issue(ctx, "Presentation binding is outside publication")
  validateCardFieldPresentation(p, ctx)
  if (p.board.presentation?.cardStageButtons?.some(button => !p.columns.some(column => column.id === button.columnId))) issue(ctx, "Stage button is outside publication")
}

function validateCardFieldPresentation(p: PublicBoardProjection, ctx: z.RefinementCtx): void {
  const presentation = p.board.presentation?.cardPresentation
  const fieldIds = new Set(p.fields.map(field => field.id))
  const configuredIds = [...(presentation?.titleFieldIds ?? []), ...(presentation?.summaryFieldIds ?? []), ...(presentation?.narrativeFieldId ? [presentation.narrativeFieldId] : [])]
  if (configuredIds.some(id => !fieldIds.has(id))) issue(ctx, "Card presentation field is outside publication")
  if (p.fields.some(field => field.format && field.valueType !== "text")) issue(ctx, "Text format requires a text field")
}

function validateArchiveColumn(p: PublicBoardProjection, ctx: z.RefinementCtx): void {
  const archiveColumns = p.columns.filter(column => column.archive === true)
  const archiveColumnId = p.board.presentation?.archiveColumnId
  if (archiveColumnId !== undefined && (archiveColumnId === null ? archiveColumns.length !== 0 : archiveColumns.length !== 1 || archiveColumns[0]?.id !== archiveColumnId)) issue(ctx, "Archive column binding is inconsistent")
  if (archiveColumnId === undefined && archiveColumns.length > 1) issue(ctx, "Publication has multiple archive columns")
}

function validateFieldOptions(p: PublicBoardProjection, ctx: z.RefinementCtx): void {
  for (const field of p.fields) {
    if (field.valueType !== "select" && field.options.length) issue(ctx, "Only select fields may have options")
  }
}
function issue(ctx: z.RefinementCtx, message: string): void { ctx.addIssue({ code: "custom", message }) }
function validI128Rank(value: string): boolean {
  const [numerator, denominator] = value.split("/")
  try { const n = BigInt(numerator!); const d = BigInt(denominator!); return n >= i128Min && n <= i128Max && d <= i128Max }
  catch { return false }
}
function validateCards(p: PublicBoardProjection, cards: Map<string, PublicBoardProjection["cards"][number]>, ctx: z.RefinementCtx): void {
  const columns = new Set(p.columns.map(column => column.id))
  const fieldMap = new Map(p.fields.map(field => [field.id, field]))
  for (const card of p.cards) {
    if (!columns.has(card.columnId) || card.parentId !== null && !cards.has(card.parentId)) issue(ctx, "Card reference is outside this board")
    if (card.parentId !== null && cards.get(card.parentId)?.columnId !== card.columnId) issue(ctx, "Nested card crosses columns")
    if (Object.entries(card.values).some(([fieldId, value]) => !validValue(fieldMap.get(fieldId), value))) issue(ctx, "Card value does not match its published field")
    if (hasCardCycle(card.id, cards)) issue(ctx, "Card hierarchy contains a cycle")
  }
  const archiveColumnId = p.board.presentation?.archiveColumnId
  if (archiveColumnId && p.cards.some(card => card.columnId === archiveColumnId && card.parentId !== null)) issue(ctx, "Archived cards must be placed at the archive root")
}
function validValue(field: PublicBoardProjection["fields"][number] | undefined, value: string | number | boolean | null): boolean {
  if (!field) return false
  if (value === null) return true
  if (field.valueType === "number") return typeof value === "number"
  if (field.valueType === "boolean") return typeof value === "boolean"
  if (field.valueType === "select") return typeof value === "string" && field.options.some(option => option.id === value)
  return typeof value === "string"
}
function hasCardCycle(cardId: string, cards: Map<string, PublicBoardProjection["cards"][number]>): boolean {
  const seen = new Set<string>()
  let current: string | null = cardId
  while (current !== null) {
    if (seen.has(current)) return true
    seen.add(current)
    current = cards.get(current)?.parentId ?? null
  }
  return false
}
function validateDiscussions(p: PublicBoardProjection, cards: Map<string, PublicBoardProjection["cards"][number]>, fields: Set<string>, ctx: z.RefinementCtx): void {
  const discussions = new Map(p.discussions.map(message => [message.id, message]))
  for (const message of p.discussions) {
    validateDiscussionThread(message, discussions, ctx)
    for (const target of message.targets) if (!validTarget(target, p.board.id, cards, fields)) issue(ctx, "Discussion target is outside publication")
  }
}
function validateDiscussionThread(message: PublicBoardProjection["discussions"][number], discussions: Map<string, PublicBoardProjection["discussions"][number]>, ctx: z.RefinementCtx): void {
  const root = discussions.get(message.threadId)
  if (!root || root.replyTo !== null || root.id !== root.threadId || message.replyTo === null && message.id !== message.threadId || message.replyTo !== null && discussions.get(message.replyTo)?.threadId !== message.threadId) issue(ctx, "Discussion thread structure is invalid")
  const seen = new Set<string>()
  let current: PublicBoardProjection["discussions"][number] | undefined = message
  while (current) {
    if (seen.has(current.id)) { issue(ctx, "Discussion replies contain a cycle"); return }
    seen.add(current.id)
    current = current.replyTo ? discussions.get(current.replyTo) : undefined
  }
}
function validTarget(target: PublicBoardProjection["discussions"][number]["targets"][number], boardId: string, cards: Map<string, PublicBoardProjection["cards"][number]>, fields: Set<string>): boolean {
  if (target.type === "board") return target.id === boardId && target.cardId === undefined
  if (target.type === "card") return cards.has(target.id) && target.cardId === undefined
  return fields.has(target.id) && target.cardId !== undefined && cards.has(target.cardId)
}
function validateFiles(p: PublicBoardProjection, cards: Map<string, PublicBoardProjection["cards"][number]>, ctx: z.RefinementCtx): void {
  for (const file of p.files) if (file.parentId !== p.board.id && !cards.has(file.parentId)) issue(ctx, "File parent is outside publication")
  if (p.files.reduce((total, file) => total + file.byteLength, 0) > 64 * 1024 * 1024) issue(ctx, "Public attachment total exceeds limit")
}
export type PublicBoardPresentation = {
  entityName?: string
  archiveColumnId?: string | null
  preset?: { key: string; version: 1; bindings: Record<string, string> } | null
  cardPresentation?: z.infer<typeof cardPresentationSchema>
  cardStageButtons?: Array<{ columnId: string; label?: string }>
  cardAgingPolicy?: z.infer<typeof cardAgingPolicySchema>
}
export type PublicBoardProjection = {
  kind: "tincanban-public-board"; version: 1; board: { id: string; title: string; presentation?: PublicBoardPresentation }
  columns: Array<{ id: string; title: string; rank: string; color?: string; archive?: true; collapsible?: boolean }>
  fields: Array<{ id: string; title: string; valueType: "text" | "url" | "date" | "datetime" | "boolean" | "number" | "select"; format?: "plain" | "markdown" | "json" | "code"; required: boolean; rank: string; min?: number | null; max?: number | null; options: Array<{ id: string; title: string; rank: string }> }>
  cards: Array<{ id: string; parentId: string | null; columnId: string; title: string; body: string; values: Record<string, string | number | boolean | null>; rank: string; createdAt?: string; updatedAt?: string; lastActivityAt?: string }>
  discussions: Array<{ id: string; threadId: string; replyTo: string | null; targets: Array<{ type: "board" | "card" | "field"; id: string; cardId?: string }>; author: string; createdAt: string; body: string }>
  files: Array<{ id: string; parentId: string; title: string; fileName: string; mediaType: string; byteLength: number; sha256: string }>
}
export function validatePublicBoardProjection(value: unknown): PublicBoardProjection {
  const projection = publicBoardProjectionSchema.parse(value)
  if (new TextEncoder().encode(JSON.stringify(projection)).byteLength > MAX_PROJECTION_BYTES) throw new Error("Public board exceeds the 2 MiB limit")
  return projection as PublicBoardProjection
}
