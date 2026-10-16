import { assertApplicationSourceRecord, readApplicationSourceData, type ApplicationSourceData, type ApplicationSourceEntity } from "./applicationSourceData"
import { canonicalizeJson, sha256Base64Url } from "./identityCrypto"
import { err } from "./commandTypes"
import type { CommandHandler } from "./commandHandlerTypes"
import { createItem } from "./commandBasicHandlers"

export async function verifyApplicationSourceDigest(value: unknown): Promise<ApplicationSourceData> {
  const data = readApplicationSourceData(canonicalizeJson(value))
  if (data.observation.status === "available") {
    const digest = await sha256Base64Url(new TextEncoder().encode(data.observation.text))
    if (digest !== data.observation.contentDigest) throw new Error("Application source text digest is invalid")
  }
  return data
}

export const recordApplicationSource: CommandHandler<"recordApplicationSource"> = (doc, command, context) => {
  try {
    const data = readApplicationSourceData(canonicalizeJson(command.data)), id = `application-source:${data.recordId}`
    if (doc.entities[id]) return err("conflict", "Application source records are immutable; record ID already exists")
    const entity = sourceEntity(data, context.nowIso)
    assertApplicationSourceRecord(entity, doc.entities, doc.id)
    return { ok: true, value: { changedEntityIds: [id], apply: draft => { draft.entities[id] = entity } } }
  } catch (error) {
    return err("invalid_input", error instanceof Error ? error.message : "Invalid application source")
  }
}

export const createItemWithApplicationSource: CommandHandler<"createItemWithApplicationSource"> = (doc, command, context) => {
  try {
    const data = readApplicationSourceData(canonicalizeJson(command.data))
    if (command.id !== data.cardId || data.observation.phase !== "original") return err("invalid_input", "New card requires its own original source")
    const entity = sourceEntity(data, context.nowIso)
    if (doc.entities[command.id] || doc.entities[entity.id]) return err("conflict", "Application card or source ID already exists")
    const card = createItem(doc, { ...command, kind: "createItem" }, context)
    if (!card.ok) return card
    assertApplicationSourceRecord(entity, { ...doc.entities, [command.id]: {
      id: command.id, title: command.title, body: command.body ?? "", values: command.values ?? {},
      placement: { parentId: command.parentId, rank: "0/1" }, createdAt: context.nowIso, updatedAt: context.nowIso,
    } }, doc.id)
    return { ok: true, value: { changedEntityIds: [...card.value.changedEntityIds, entity.id], apply: draft => {
      card.value.apply(draft)
      draft.entities[entity.id] = entity
    } } }
  } catch (error) {
    return err("invalid_input", error instanceof Error ? error.message : "Invalid application source")
  }
}

function sourceEntity(data: ApplicationSourceData, nowIso: string): ApplicationSourceEntity {
  return { id: `application-source:${data.recordId}`, kind: "application_source", title: "Application source",
    placement: { parentId: data.cardId, rank: "0/1" }, archivedAt: null,
    createdAt: nowIso, updatedAt: nowIso, data: canonicalizeJson(data) }
}
