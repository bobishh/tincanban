import type { Item, FieldDefinition } from "../domain/model"
import type { PublicBoardProjection } from "./publicSchema"
import type { Anchor } from "../chat/context"
import type { ReferenceChoice } from "../chat/referenceChoices"

export type PublicChatMessage = {
  id: string
  workspaceId: string
  personId: string
  name: string
  body: string
  createdAt: string
  context: { references: Anchor[]; mentions: string[]; replyTo?: string; conversationRootId?: string }
}

export function publicDiscussionView(projection: PublicBoardProjection) {
  const scope = `public:${projection.board.id}`
  const itemById = new Map(projection.cards.map(card => [card.id, card]))
  const fieldTitles = Object.fromEntries(projection.fields.map(field => [field.id, field.title]))
  const memberAvatars = Object.fromEntries((projection.discussionAuthors ?? []).flatMap(author => author.avatarData ? [[author.id, author.avatarData]] : []))
  const allMessages: PublicChatMessage[] = projection.discussions.map(message => {
    const references = message.targets.flatMap(target => {
      if (target.type === "board") return []
      const itemId = target.type === "card" ? target.id : target.cardId
      if (!itemId || !itemById.has(itemId)) return []
      return [{ workspaceScope: scope, boardId: projection.board.id, itemId,
        ...(target.type === "field" ? { fieldId: target.id } : {}) }]
    })
    return { id: message.id, workspaceId: scope, personId: message.authorId ?? "", name: message.author, body: message.body,
      createdAt: message.createdAt, context: { references, mentions: [], ...(message.replyTo ? { replyTo: message.replyTo, conversationRootId: message.threadId } : {}) } }
  })
  const referenceChoices: ReferenceChoice[] = projection.cards.flatMap(card => {
    const anchor: Anchor = { workspaceScope: scope, boardId: projection.board.id, itemId: card.id }
    return [{ title: card.title, anchor, type: "Card" as const }, ...projection.fields.flatMap(field => {
      const value = card.values[field.id]
      return value === null || value === undefined || value === "" ? [] : [{ title: `${card.title} · ${field.title}`,
        anchor: { ...anchor, fieldId: field.id }, type: "Field" as const, searchText: String(value) }]
    })]
  })
  const cardDiscussions = new Map<string, { count: number; messageId?: string }>()
  for (const message of projection.discussions) for (const target of message.targets) {
    const itemId = target.type === "card" ? target.id : target.type === "field" ? target.cardId : undefined
    if (!itemId) continue
    const prior = cardDiscussions.get(itemId)
    cardDiscussions.set(itemId, { count: (prior?.count ?? 0) + 1, messageId: message.id })
  }
  const boardWindow = () => ({ id: `board:${projection.board.id}`, targetId: projection.board.id, rootId: null as string | null })
  const cardWindow = (itemId: string) => itemById.has(itemId) ? ({ id: `card:${itemId}`, targetId: itemId, rootId: null as string | null }) : null
  const threadWindow = (messageId: string) => {
    const message = projection.discussions.find(candidate => candidate.id === messageId)
    return message ? { id: `conversation:${message.threadId}`, targetId: messageId, rootId: message.threadId,
      context: { references: allMessages.find(candidate => candidate.id === message.threadId)?.context.references ?? [], mentions: [], replyTo: message.threadId, conversationRootId: message.threadId } } : null
  }
  function messages(window: { targetId: string; rootId: string | null }): PublicChatMessage[] {
    if (window.rootId) return allMessages.filter(message => message.id === window.rootId || message.context.replyTo === window.rootId)
    if (window.targetId === projection.board.id) return allMessages
    return allMessages.filter(message => message.context.references.some(anchor => anchor.itemId === window.targetId))
  }
  function referenceCard(anchor: Anchor): string | null {
    return anchor.workspaceScope === scope && anchor.boardId === projection.board.id && itemById.has(anchor.itemId) ? anchor.itemId : null
  }
  return { scope, allMessages, memberAvatars, fieldTitles, referenceChoices, cardDiscussions, boardWindow, cardWindow, threadWindow, messages, referenceCard }
}

export function publicItemDocuments(projection: PublicBoardProjection, itemId: string) {
  const files = projection.files.filter(file => file.parentId === itemId)
  return files.map(file => ({ id: file.id, itemId: itemId, kind: "attachment" as const, title: file.title,
    format: file.mediaType === "application/pdf" ? "pdf" as const : "file" as const,
    file: { type: "blob" as const, sha256: file.sha256, byteLength: file.byteLength, mimeType: file.mediaType, fileName: file.fileName },
    createdAt: "", updatedAt: "" }))
}

export function publicReferenceItem(anchor: Anchor, scope: string, boardId: string, items: readonly Item[], fields: readonly FieldDefinition[]): string | null {
  if (anchor.workspaceScope !== scope || anchor.boardId !== boardId || !items.some(item => item.id === anchor.itemId)) return null
  if (anchor.fieldId && anchor.fieldId !== "narrative" && !fields.some(field => field.id === anchor.fieldId)) return null
  return anchor.itemId
}
