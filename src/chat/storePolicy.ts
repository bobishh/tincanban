import { validateMessageContext, type MessageContext } from "./context"
export type StoredChatMessage = {
  id: string
  workspaceId: string
  personId: string
  createdAt: string
  body: string
  record: unknown
  context?: MessageContext
}

export type StoredChatProfile = {
  workspaceId: string
  personId: string
  name: string
  revision: number
  record: unknown
}

export type ChatSnapshot = {
  messages: StoredChatMessage[]
  profiles: StoredChatProfile[]
}

export interface StoredMessageInternal extends StoredChatMessage {
  orderKey: string
  serializedBytes: number
}

export interface WorkspaceMetaInternal {
  workspaceId: string
  cursor: string | null
  pruneCutoff: string | null
  contentRevision?: number
  contentGeneration?: string
}

export const DEFAULT_DB_NAME = "tincanban-chat-v1"
const MAX_WORKSPACE_MESSAGES = 2000
const MAX_WORKSPACE_BYTES = 4 * 1024 * 1024
export const MAX_WORKSPACE_PROFILES = 512
export const MAX_RECORD_BYTES = 32 * 1024
export const MAX_BODY_CODEPOINTS = 8000
const MAX_STRING_FIELD_LENGTH = 256

export const STORE_MESSAGES = "messages"
export const STORE_PROFILES = "profiles"
export const STORE_META = "meta"
export const INDEX_MSG_WORKSPACE_ORDER = "by_workspace_order"
export const INDEX_MSG_WORKSPACE = "by_workspace"
export const INDEX_PROF_WORKSPACE = "by_workspace"

const textEncoder = new TextEncoder()

function canonicalArray(value: unknown[], seen: Set<unknown>): string {
  const items = value.map((item) => (item === undefined ? "null" : canonicalJsonInternal(item, seen)))
  return `[${items.join(",")}]`
}

function canonicalObject(value: object, seen: Set<unknown>): string {
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined && typeof item !== "function" && typeof item !== "symbol")
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonInternal(item, seen)}`)
  return `{${entries.join(",")}}`
}

function canonicalComposite(value: object, seen: Set<unknown>): string {
  if (seen.has(value)) throw new TypeError("Circular reference detected in object")
  seen.add(value)
  try {
    return Array.isArray(value) ? canonicalArray(value, seen) : canonicalObject(value, seen)
  } finally {
    seen.delete(value)
  }
}

function canonicalJsonInternal(value: unknown, seen: Set<unknown>): string {
  if (value === null) return "null"
  if (typeof value === "bigint") throw new TypeError("BigInt cannot be serialized to canonical JSON")
  if (typeof value === "object") return canonicalComposite(value, seen)
  if (["boolean", "number", "string"].includes(typeof value)) return JSON.stringify(value)
  return "null"
}

export function canonicalJson(value: unknown): string {
  return canonicalJsonInternal(value, new Set())
}

function getSerializedBytes(value: unknown): number {
  return textEncoder.encode(canonicalJson(value)).byteLength
}

export function getMessageRecordSerializedBytes(message: StoredChatMessage): number {
  return textEncoder.encode(canonicalJson(message)).byteLength
}

export function messageOrderKey(message: { createdAt: string; id: string }): string {
  return `${message.createdAt}|${message.id}`
}

export function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function validateRequiredString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_FIELD_LENGTH) {
    throw new Error(`${label} must be a string between 1 and ${MAX_STRING_FIELD_LENGTH} characters`)
  }
}

function validateMessageTimestamp(createdAt: unknown): asserts createdAt is string {
  if (typeof createdAt !== "string" || createdAt.length === 0 || createdAt.length > 128) {
    throw new Error("Message createdAt must be a valid timestamp string")
  }
  if (Number.isNaN(Date.parse(createdAt))) throw new Error("Message createdAt must be a valid ISO timestamp")
}

function validateMessageBody(body: unknown): asserts body is string {
  if (typeof body !== "string") throw new Error("Message body must be a string")
  if (Array.from(body).length > MAX_BODY_CODEPOINTS) {
    throw new Error(`Message body exceeds maximum ${MAX_BODY_CODEPOINTS} codepoints`)
  }
}

function validateRecordSize(record: unknown, label: string): void {
  const recordBytes = getSerializedBytes(record)
  if (recordBytes > MAX_RECORD_BYTES) {
    throw new Error(`${label} record serialized bytes (${recordBytes}) exceeds ${MAX_RECORD_BYTES} bytes limit`)
  }
}

export function validateMessage(message: StoredChatMessage): void {
  if (!message || typeof message !== "object") throw new Error("Message must be a non-null object")
  validateRequiredString(message.id, "Message id")
  validateRequiredString(message.workspaceId, "Message workspaceId")
  validateRequiredString(message.personId, "Message personId")
  validateMessageTimestamp(message.createdAt)
  validateMessageBody(message.body)
  validateRecordSize(message.record, "Message")
  if (message.context !== undefined) validateMessageContext(message.context, message.workspaceId, message.id)
  const payload = (message.record as { signed?: { payload?: Record<string, unknown> } })?.signed?.payload
  if (payload?.kind === "chat-message") {
    if (payload.id !== message.id || payload.workspaceId !== message.workspaceId || payload.personId !== message.personId || payload.createdAt !== message.createdAt || payload.text !== message.body || canonicalJson(payload.context) !== canonicalJson(message.context)) {
      throw new Error("Message projection differs from signed payload")
    }
  }
}

export function validateProfile(profile: StoredChatProfile): void {
  if (!profile || typeof profile !== "object") throw new Error("Profile must be a non-null object")
  validateRequiredString(profile.workspaceId, "Profile workspaceId")
  validateRequiredString(profile.personId, "Profile personId")
  if (typeof profile.name !== "string" || profile.name.length > 500) {
    throw new Error("Profile name must be a string with length <= 500")
  }
  if (typeof profile.revision !== "number" || !Number.isInteger(profile.revision) || profile.revision < 0) {
    throw new Error("Profile revision must be a non-negative integer")
  }
  validateRecordSize(profile.record, "Profile")
}

export function validateWorkspaceId(workspaceId: string): void {
  if (typeof workspaceId !== "string" || !workspaceId || workspaceId.length > MAX_STRING_FIELD_LENGTH) {
    throw new Error(`Invalid workspaceId: must be string between 1 and ${MAX_STRING_FIELD_LENGTH}`)
  }
}

export function areMessagesIdentical(left: StoredChatMessage, right: StoredChatMessage): boolean {
  return (
    left.id === right.id &&
    left.workspaceId === right.workspaceId &&
    left.personId === right.personId &&
    left.createdAt === right.createdAt &&
    left.body === right.body &&
    canonicalJson(left.context) === canonicalJson(right.context) &&
    canonicalJson(left.record) === canonicalJson(right.record)
  )
}

export function doesProfileWin(incoming: StoredChatProfile, existing: StoredChatProfile): boolean {
  if (incoming.revision !== existing.revision) return incoming.revision > existing.revision
  const recordOrder = compareText(canonicalJson(incoming.record), canonicalJson(existing.record))
  if (recordOrder !== 0) return recordOrder > 0
  return incoming.name > existing.name
}

export function computeRetention(allMessages: StoredMessageInternal[]): {
  pruned: StoredMessageInternal[]
  retainedIds: Set<string>
} {
  const retainedIds = new Set<string>()
  let retainedCount = 0
  let totalBytes = 0
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    const message = allMessages[index]
    if (retainedCount + 1 > MAX_WORKSPACE_MESSAGES) break
    if (totalBytes + message.serializedBytes > MAX_WORKSPACE_BYTES) break
    retainedIds.add(message.id)
    retainedCount += 1
    totalBytes += message.serializedBytes
  }
  return { pruned: allMessages.slice(0, allMessages.length - retainedCount), retainedIds }
}

export function prepareMessageBatch(workspaceId: string, messages: StoredChatMessage[]): Map<string, StoredChatMessage> {
  if (!Array.isArray(messages)) throw new Error("messages must be an array")
  const batch = new Map<string, StoredChatMessage>()
  for (const message of messages) {
    if (message.workspaceId !== workspaceId) {
      throw new Error(
        `Incoming message workspaceId '${message.workspaceId}' does not match target workspaceId '${workspaceId}'`
      )
    }
    validateMessage(message)
    const previous = batch.get(message.id)
    if (previous && !areMessagesIdentical(previous, message)) {
      throw new Error(`Message conflict in batch: immutable content mismatch for [${workspaceId}, ${message.id}]`)
    }
    batch.set(message.id, previous ?? message)
  }
  return batch
}

export function prepareProfileBatch(workspaceId: string, profiles: StoredChatProfile[]): Map<string, StoredChatProfile> {
  if (!Array.isArray(profiles)) throw new Error("profiles must be an array")
  const batch = new Map<string, StoredChatProfile>()
  for (const profile of profiles) {
    if (profile.workspaceId !== workspaceId) {
      throw new Error(
        `Incoming profile workspaceId '${profile.workspaceId}' does not match target workspaceId '${workspaceId}'`
      )
    }
    validateProfile(profile)
    const previous = batch.get(profile.personId)
    if (!previous || doesProfileWin(profile, previous)) batch.set(profile.personId, profile)
  }
  return batch
}
