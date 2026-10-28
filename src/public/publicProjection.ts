import { compareRanks } from "../domain/ancestry"
import { columnColors } from "../domain/columnColors"
import { itemNarrative } from "../domain/narrative"
import { memberAvatarData } from "../domain/avatarData"
import { orderItemsByPriority, projectItemPriority } from "../domain/priority"
import { isArchiveColumn, isItemArchived } from "../domain/archive"
import { isItem, type FileReference, type WorkspaceDocumentV2, type WorkspaceEntity } from "../domain/model"
import { conversationRoots, type Anchor } from "../chat/context"
import type { StoredChatMessage } from "../chat/storePolicy"
import { archivedItemsForBoard } from "../domain/archive"
import { validatePublicBoardProjection, type PublicBoardProjection } from "./publicSchema"
export { validatePublicBoardProjection } from "./publicSchema"
export type { PublicBoardProjection } from "./publicSchema"

const MAX_COLUMNS = 100
const MAX_FIELDS = 200
const MAX_CARDS = 5000
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_FILE_BYTES = 64 * 1024 * 1024
type PublicBoardAsset = { sha256: string; bytes: Uint8Array }
export type PublicBoardPublication = { projection: PublicBoardProjection; assets: PublicBoardAsset[] }
export type PublicAssetStager = (asset: PublicBoardAsset) => Promise<void>
type Entity = WorkspaceEntity & { placement: { parentId: string | null; rank: string }; archivedAt?: string | null }
type PublicTarget = PublicBoardProjection["discussions"][number]["targets"][number]
type PublicField = PublicBoardProjection["fields"][number]

type PublicFileReference = { reference?: FileReference | null; text?: string; suffix?: string; mediaType?: string }
type ProjectedFiles = { files: PublicBoardProjection["files"]; assets: PublicBoardAsset[] }
type PublicProjectionChat = { scope: string; messages: StoredChatMessage[]; profiles: Array<{ personId: string; name: string }> }
export type PublicProjectionPorts = {
  chat?: PublicProjectionChat
  readFile?: (reference: FileReference) => Promise<Uint8Array | undefined>
  /** Content outside this writer's authority, from its exact public CAS base. */
  retainedContent?: Pick<PublicBoardProjection, "discussions" | "discussionAuthors" | "files">
}

export function snapshotPublicBoardSource(document: WorkspaceDocumentV2, boardId: string): WorkspaceDocumentV2 {
  const all = Object.values(document.entities) as Entity[]
  const byParent = new Map<string, Entity[]>()
  for (const entity of all) {
    const children = byParent.get(entity.placement.parentId ?? "") ?? []
    children.push(entity)
    byParent.set(entity.placement.parentId ?? "", children)
  }
  const selected = new Set<string>([boardId])
  const pending = [boardId]
  while (pending.length) {
    const parent = pending.pop()!
    for (const entity of byParent.get(parent) ?? []) if (!selected.has(entity.id)) { selected.add(entity.id); pending.push(entity.id) }
  }
  const entities = Object.fromEntries(all.filter(entity => selected.has(entity.id)).map(entity => [entity.id, structuredClone(entity)]))
  return { entities } as WorkspaceDocumentV2
}

function active(entity: Entity): boolean { return isItem(entity) ? !isItemArchived(entity) : entity.archivedAt == null }
function compare<T extends { placement: { rank: string }; id: string }>(left: T, right: T): number {
  return compareRanks(left.placement.rank, right.placement.rank) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
}

export async function createPublicBoardPublication(document: WorkspaceDocumentV2, workspaceId: string, boardId: string, stageAsset: PublicAssetStager | undefined, ports: PublicProjectionPorts): Promise<PublicBoardPublication> {
  const board = document.entities[boardId]
  if (!board || !("kind" in board) || board.kind !== "board" || !active(board)) throw new Error("Selected board is unavailable")
  const entities = Object.values(document.entities) as Entity[]
  const children = childLookup(entities)
  const boardColumns = children(boardId).filter((entity): entity is Extract<WorkspaceEntity, { kind: "column" }> => "kind" in entity && entity.kind === "column")
  const colors = columnColors(boardColumns)
  const columns = boardColumns
  const fields = children(boardId).filter((entity): entity is PublicFieldEntity => "kind" in entity && entity.kind === "field")
  if (columns.length > MAX_COLUMNS || fields.length > MAX_FIELDS) throw new Error("Public board exceeds collection limits")
  const publicFields = projectFields(fields)
  const archiveColumn = columns.find(column => isArchiveColumn(column, board))
  const cards = projectCards(board, columns.filter(column => !isArchiveColumn(column, board)), children, publicFields, archiveColumn?.id, document)
  const projection: PublicBoardProjection = {
    kind: "tincanban-public-board", version: 1, board: { id: board.id, title: board.title, presentation: publicPresentation(board, columns, publicFields) },
    columns: columns.map(entity => ({ id: entity.id, title: entity.title, rank: entity.placement.rank, color: colors.get(entity.id), ...(isArchiveColumn(entity, board) ? { archive: true as const } : {}), ...( "collapsible" in entity ? { collapsible: entity.collapsible } : {}) })),
    fields: publicFields, cards, discussions: [], files: [],
  }
  if (ports.retainedContent) {
    const { discussions, discussionAuthors, files } = ports.retainedContent
    return { projection: validatePublicBoardProjection({ ...projection, discussions, files,
      ...(discussionAuthors ? { discussionAuthors } : {}) }), assets: [] }
  }
  const chat = ports.chat ?? { scope: workspaceId, messages: [], profiles: [] }
  const memberAvatars = new Map(entities.flatMap(entity => entity.kind === "member_profile" ?
    [[entity.personId, memberAvatarData(entity.data)] as const] : []))
  const discussionProjection = await projectDiscussions(chat.messages, chat.profiles, chat.scope, boardId, publicFields, cards, memberAvatars)
  projection.discussions = discussionProjection.messages
  projection.discussionAuthors = discussionProjection.authors
  const projectedFiles = await projectFiles(entities, boardId, new Set(cards.map(card => card.id)), stageAsset, ports.readFile)
  projection.files = projectedFiles.files
  return { projection: validatePublicBoardProjection(projection), assets: projectedFiles.assets }
}

function publicPresentation(board: Extract<WorkspaceEntity, { kind: "board" }>, columns: Entity[], fields: PublicBoardProjection["fields"]): NonNullable<PublicBoardProjection["board"]["presentation"]> {
  const visibleIds = new Set([...columns.map(column => column.id), ...fields.map(field => field.id), ...fields.flatMap(field => field.options.map(option => option.id))])
  const fieldIds = new Set(fields.map(field => field.id))
  const cardPresentation = board.cardPresentation ? {
    ...(board.cardPresentation.openAfterSave !== undefined ? { openAfterSave: board.cardPresentation.openAfterSave } : {}),
    ...(board.cardPresentation.titleFieldIds ? { titleFieldIds: board.cardPresentation.titleFieldIds.filter(id => fieldIds.has(id)) } : {}),
    ...(board.cardPresentation.summaryFieldIds ? { summaryFieldIds: board.cardPresentation.summaryFieldIds.filter(id => fieldIds.has(id)) } : {}),
    ...(board.cardPresentation.narrativeFieldId && fieldIds.has(board.cardPresentation.narrativeFieldId) ? { narrativeFieldId: board.cardPresentation.narrativeFieldId } : {}),
  } : undefined
  return {
    ...(cardPresentation ? { cardPresentation } : {}),
    ...(board.entityName ? { entityName: board.entityName } : {}),
    ...( "archiveColumnId" in board ? { archiveColumnId: board.archiveColumnId } : {}),
    preset: board.preset ? { ...board.preset, bindings: Object.fromEntries(Object.entries(board.preset.bindings).filter(([, id]) => visibleIds.has(id))) } : null,
    ...(board.cardStageButtons ? { cardStageButtons: board.cardStageButtons.filter(button => columns.some(column => column.id === button.columnId)) } : {}),
    ...(board.cardAgingPolicy ? { cardAgingPolicy: board.cardAgingPolicy } : {}),
  }
}

type PublicFieldEntity = Extract<WorkspaceEntity, { kind: "field" }>
function childLookup(entities: Entity[]) {
  const map = new Map<string, Entity[]>()
  for (const entity of entities) {
    const list = map.get(entity.placement.parentId ?? "") ?? []
    list.push(entity)
    map.set(entity.placement.parentId ?? "", list)
  }
  return (parentId: string) => (map.get(parentId) ?? []).filter(active).sort(compare)
}
function projectFields(fields: PublicFieldEntity[]): PublicBoardProjection["fields"] {
  return fields.map(field => ({
    id: field.id, title: field.title, valueType: field.valueType, ...(field.valueType === "text" && field.format ? { format: field.format } : {}), required: field.required, rank: field.placement.rank, ...(field.valueType === "number" ? { min: field.min, max: field.max } : {}),
    options: field.valueType === "select"
      ? Object.values(field.options).filter(option => option.archivedAt == null).sort((a, b) => compareRanks(a.rank, b.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(option => ({ id: option.id, title: option.title, rank: option.rank }))
      : [],
  }))
}
function projectCards(board: Extract<WorkspaceEntity, { kind: "board" }>, columns: Entity[], children: (id: string) => Entity[], fields: PublicBoardProjection["fields"], archiveColumnId: string | undefined, document: WorkspaceDocumentV2): PublicBoardProjection["cards"] {
  const fieldMap = new Map(fields.map(field => [field.id, field]))
  const cards: PublicBoardProjection["cards"] = []
  const visited = new Set<string>()
  const walk = (parentId: string, columnId: string, cardParentId: string | null): void => {
    const items = children(parentId).filter(isItem)
    for (const source of orderItemsByPriority(board, items, board.cardPresentation?.narrativeFieldId)) {
      const entity = projectItemPriority(board, source, board.cardPresentation?.narrativeFieldId)
      if (visited.has(entity.id)) throw new Error("Public card hierarchy contains a cycle")
      visited.add(entity.id)
      const values = Object.fromEntries(Object.entries(entity.values ?? {}).filter(([fieldId, value]) => validFieldValue(fieldMap.get(fieldId), value)))
      cards.push({ id: entity.id, parentId: cardParentId, columnId, title: entity.title, body: itemNarrative(entity, board.cardPresentation?.narrativeFieldId, children(entity.id).filter(candidate => "kind" in candidate && candidate.kind === "document") as Extract<WorkspaceEntity, { kind: "document" }>[]), values, rank: entity.placement.rank, ...(entity.createdAt ? { createdAt: entity.createdAt } : {}), ...(entity.updatedAt ? { updatedAt: entity.updatedAt } : {}), ...(entity.lastActivityAt ? { lastActivityAt: entity.lastActivityAt } : {}) })
      if (cards.length > MAX_CARDS) throw new Error("Public board exceeds card limit")
      walk(entity.id, columnId, entity.id)
    }
  }
  for (const column of columns) walk(column.id, column.id, null)
  if (archiveColumnId) {
    for (const source of orderItemsByPriority(board, archivedItemsForBoard(document, board.id), board.cardPresentation?.narrativeFieldId)) {
      if (visited.has(source.id)) throw new Error("Public card hierarchy contains a cycle")
      visited.add(source.id)
      const entity = projectItemPriority(board, source, board.cardPresentation?.narrativeFieldId)
      const values = Object.fromEntries(Object.entries(entity.values ?? {}).filter(([fieldId, value]) => validFieldValue(fieldMap.get(fieldId), value)))
      cards.push({ id: entity.id, parentId: null, columnId: archiveColumnId, title: entity.title,
        body: itemNarrative(entity, board.cardPresentation?.narrativeFieldId, children(entity.id).filter(candidate => "kind" in candidate && candidate.kind === "document") as Extract<WorkspaceEntity, { kind: "document" }>[]),
        values, rank: entity.placement.rank, ...(entity.createdAt ? { createdAt: entity.createdAt } : {}), ...(entity.updatedAt ? { updatedAt: entity.updatedAt } : {}), ...(entity.lastActivityAt ? { lastActivityAt: entity.lastActivityAt } : {}) })
      if (cards.length > MAX_CARDS) throw new Error("Public board exceeds card limit")
    }
  }
  return cards
}
function validFieldValue(field: PublicField | undefined, value: unknown): value is string | number | boolean | null {
  if (!field) return false
  if (value === null) return true
  if (field.valueType === "number") return typeof value === "number" && Number.isFinite(value)
  if (field.valueType === "boolean") return typeof value === "boolean"
  if (field.valueType === "select") return typeof value === "string" && field.options.some(option => option.id === value)
  return typeof value === "string"
}
function targetFor(anchor: Anchor, scope: string, boardId: string, fieldIds: Set<string>, cardIds: Set<string>): PublicTarget | undefined {
  if (anchor.workspaceScope !== scope || anchor.boardId !== boardId) return undefined
  if (anchor.fieldId) {
    if (!cardIds.has(anchor.itemId)) return undefined
    if (["title", "narrative", "overview"].includes(anchor.fieldId)) return { type: "card", id: anchor.itemId }
    if (!fieldIds.has(anchor.fieldId)) return undefined
    return { type: "field", id: anchor.fieldId, cardId: anchor.itemId }
  }
  if (cardIds.has(anchor.itemId)) return { type: "card", id: anchor.itemId }
  if (anchor.itemId === boardId) return { type: "board", id: boardId }
  return undefined
}
async function projectDiscussions(messages: StoredChatMessage[], profiles: Array<{ personId: string; name: string }>, scope: string, boardId: string, fields: PublicBoardProjection["fields"], cards: PublicBoardProjection["cards"], memberAvatars: Map<string, string | undefined>): Promise<{ messages: PublicBoardProjection["discussions"]; authors: NonNullable<PublicBoardProjection["discussionAuthors"]> }> {
  const cardIds = new Set(cards.map(card => card.id))
  const fieldIds = new Set(fields.map(field => field.id))
  const roots = conversationRoots(messages)
  const target = (anchor: Anchor) => targetFor(anchor, scope, boardId, fieldIds, cardIds)
  const includedRoots = includedDiscussionRoots(messages, roots, target)
  const ids = await publicDiscussionIds(messages, roots, includedRoots)
  const projectedMessages = await buildPublicDiscussions(messages, profiles, roots, includedRoots, ids, target)
  const includedPersonIds = new Set(messages.filter(message => includedRoots.has(roots.get(message.id)?.rootId ?? "")).map(message => message.personId))
  const photoAuthors = [...includedPersonIds].filter(personId => memberAvatars.has(personId)).slice(0, 64)
  const authors = await Promise.all(photoAuthors.map(async personId => ({ id: await publicOpaqueId(personId), avatarData: memberAvatars.get(personId)! })))
  return { messages: projectedMessages, authors }
}
async function publicDiscussionIds(messages: StoredChatMessage[], roots: ReturnType<typeof conversationRoots>, includedRoots: Set<string>): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const message of messages) if (includedRoots.has(roots.get(message.id)?.rootId ?? "")) ids.set(message.id, await publicOpaqueId(message.id))
  return ids
}
async function buildPublicDiscussions(messages: StoredChatMessage[], profiles: Array<{ personId: string; name: string }>, roots: ReturnType<typeof conversationRoots>, includedRoots: Set<string>, ids: Map<string, string>, target: (anchor: Anchor) => PublicTarget | undefined): Promise<PublicBoardProjection["discussions"]> {
  const byId = new Map(messages.map(message => [message.id, message]))
  const profileNames = new Map(profiles.map(profile => [profile.personId, profile.name]))
  const output: PublicBoardProjection["discussions"] = []
  for (const message of messages) {
    if (!includedRoots.has(roots.get(message.id)?.rootId ?? "")) continue
    const rootMessage = byId.get(roots.get(message.id)?.rootId ?? "")
    const targets = discussionTargets(message, rootMessage, target)
    if (!targets.length) continue
    output.push(await publicDiscussion(message, targets, roots.get(message.id)!.rootId, ids, profileNames))
  }
  output.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return output
}
function discussionTargets(message: StoredChatMessage, root: StoredChatMessage | undefined, target: (anchor: Anchor) => PublicTarget | undefined): PublicTarget[] {
  const ownTargets = (message.context?.references ?? []).map(target).filter(isDefined)
  return ownTargets.length ? ownTargets : (root?.context?.references ?? []).map(target).filter(isDefined)
}
async function publicDiscussion(message: StoredChatMessage, targets: PublicTarget[], rootId: string, ids: Map<string, string>, profileNames: Map<string, string>): Promise<PublicBoardProjection["discussions"][number]> {
  return { id: ids.get(message.id)!, threadId: await publicOpaqueId(rootId), replyTo: message.context?.replyTo ? ids.get(message.context.replyTo) ?? null : null,
    authorId: await publicOpaqueId(message.personId),
    targets, author: profileNames.get(message.personId) ?? "Participant", createdAt: message.createdAt, body: message.body }
}
function includedDiscussionRoots(messages: StoredChatMessage[], roots: ReturnType<typeof conversationRoots>, target: (anchor: Anchor) => PublicTarget | undefined): Set<string> {
  const included = new Set<string>()
  for (const message of messages) {
    if (!message.context?.references.some(anchor => target(anchor))) continue
    const root = roots.get(message.id)
    if (root?.state === "invalid") throw new Error("A selected board discussion has invalid reply history")
    if (root?.state === "unavailable") throw new Error("A selected board discussion is incomplete; reconnect a device with full history")
    if (root) included.add(root.rootId)
  }
  return included
}
function isDefined<T>(value: T | undefined): value is T { return value !== undefined }
async function projectFiles(entities: Entity[], boardId: string, cardIds: Set<string>, stageAsset?: PublicAssetStager, readFile?: PublicProjectionPorts["readFile"]): Promise<ProjectedFiles> {
  const files: PublicBoardProjection["files"] = []
  const knownAssets = new Map<string, number>()
  const assets: PublicBoardAsset[] = []
  for (const entity of entities) {
    if (!active(entity) || entity.placement.parentId !== boardId && !cardIds.has(entity.placement.parentId ?? "") || !("kind" in entity)) continue
    const refs = attachedReferences(entity)
    for (let index = 0; index < refs.length; index++) {
      const content = await readPublicFile(entity, refs[index], readFile)
      if (content.bytes.byteLength > MAX_FILE_BYTES) throw new Error(`Attachment ${content.fileName} exceeds the 16 MiB public file limit`)
      const sha256 = await hashBytes(content.bytes)
      if (!knownAssets.has(sha256)) {
        const totalBytes = [...knownAssets.values()].reduce((total, size) => total + size, content.bytes.byteLength)
        if (totalBytes > MAX_TOTAL_FILE_BYTES) throw new Error("Board attachments exceed the 64 MiB total public file limit")
        knownAssets.set(sha256, content.bytes.byteLength)
        if (stageAsset) await stageAsset({ sha256, bytes: content.bytes })
        else assets.push({ sha256, bytes: content.bytes })
      }
      files.push({ id: await publicOpaqueId(`${entity.id}:${index}:${sha256}`), parentId: entity.placement.parentId!, title: entity.title,
        fileName: safeFileName(content.fileName), mediaType: content.mediaType, byteLength: content.bytes.byteLength, sha256 })
    }
  }
  return { files, assets }
}
function attachedReferences(entity: Entity): PublicFileReference[] {
  if ("kind" in entity && entity.kind === "document") {
    if (entity.format === "path") throw new Error(`Attachment ${entity.title} is a private local path and cannot be published; attach the file contents first`)
    if (entity.file) return [{ reference: entity.file }]
    if (entity.content !== null) return [{ text: entity.content, suffix: entity.format === "markdown" ? "md" : "txt", mediaType: entity.format === "html" ? "text/plain;charset=utf-8" : "text/markdown;charset=utf-8" }]
  }
  if ("kind" in entity && entity.kind === "artifact") return [{ reference: entity.pdf, suffix: "pdf" }, ...(entity.sourceMarkdown ? [{ reference: entity.sourceMarkdown, suffix: "md" }] : [])]
  return []
}
async function readPublicFile(entity: Entity, file: PublicFileReference, readFile?: PublicProjectionPorts["readFile"]): Promise<{ bytes: Uint8Array; fileName: string; mediaType: string }> {
  if (file.reference) {
    if (file.reference.type !== "blob") throw new Error(`Attachment ${file.reference.fileName} is local to one device and cannot be published`)
    let bytes: Uint8Array | undefined
    try { bytes = await readFile?.(file.reference) }
    catch (cause) { throw new Error(`Attachment ${file.reference.fileName} is unavailable; reconnect a source device before publishing`, { cause }) }
    if (!bytes) throw new Error(`Attachment ${file.reference.fileName} is unavailable; reconnect a source device before publishing`)
    return { bytes, fileName: file.reference.fileName, mediaType: file.reference.mimeType }
  }
  const bytes = new TextEncoder().encode(file.text ?? "")
  return { bytes, fileName: `${safeFileName(entity.title)}.${file.suffix ?? "txt"}`, mediaType: file.mediaType ?? "text/plain;charset=utf-8" }
}
async function publicOpaqueId(value: string): Promise<string> { return hashBytes(new TextEncoder().encode(value)) }
async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)))
  let binary = ""; for (const byte of digest) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
function safeFileName(name: string): string {
  const basename = name.split(/[\\/]/u).at(-1) ?? ""
  return basename.replace(/\p{Cc}/gu, "_").slice(0, 255) || "attachment"
}
