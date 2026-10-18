import { normalizeMessageContext, type MessageContext } from "./context"
import { chatStore, type StoredChatMessage, type StoredChatProfile } from "./store"
import { verifyChatRecord, type ChatRecord } from "./records"
import { meshTrace } from "../sync/meshTrace"

export type ChatChange = { workspaceId: string; added: StoredChatMessage[]; remote: boolean; history: boolean; typing?: ChatRecord[] }
export type ChatTyping = { personId: string; deviceId: string }
const listeners = new Set<(event: ChatChange) => void>()
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("tincanban-chat")
const typingTtlMs = 6_000
const typingRecords = new Map<string, Map<string, { record: ChatRecord; receivedAt: number }>>()
let readOwner: (workspaceId: string) => Promise<string> = async () => { throw new Error("Workspace unavailable") }
const peerCapabilities = new Map<string, Map<string, boolean>>()
let readScope: (workspaceId: string) => Promise<string> = async id => id

function publish(event: ChatChange) {
  for (const listener of listeners) listener(event)
  channel?.postMessage(event)
}

channel?.addEventListener("message", event => {
  const change = event.data as ChatChange
  if (typeof change?.workspaceId === "string" && Array.isArray(change.added)) {
    for (const record of change.typing ?? []) rememberTyping(change.workspaceId, record)
    for (const listener of listeners) listener(change)
  }
})

export function configureChat(owner: typeof readOwner, scope: typeof readScope) { readOwner = owner; readScope = scope }
export function subscribeChat(listener: (event: ChatChange) => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export async function getChatScope(workspaceId: string) { return readScope(workspaceId) }
export async function getChatProjectionAccess(workspaceId: string) {
  const [ownerPersonId, scope] = await Promise.all([readOwner(workspaceId), readScope(workspaceId)])
  return { ownerPersonId, scope }
}
export function notifyChatProfileProjection(workspaceId: string) { publish({ workspaceId, added: [], remote: true, history: true }) }
export async function loadChat(workspaceId: string) { return chatStore.load(await readScope(workspaceId)) }
export async function readChatCursor(workspaceId: string) { return chatStore.readCursor(await readScope(workspaceId)) }
export async function readChatContentRevision(workspaceId: string) { return chatStore.readContentRevision(await readScope(workspaceId)) }
export async function markChatRead(workspaceId: string, cursor: string) { return chatStore.markRead(await readScope(workspaceId), cursor) }

function rememberTyping(workspaceId: string, record: ChatRecord) {
  const payload = record?.signed?.payload
  if (payload?.kind !== "chat-typing" || payload.workspaceId === "" || !payload.deviceId) return false
  const byDevice = typingRecords.get(workspaceId) ?? new Map<string, { record: ChatRecord; receivedAt: number }>()
  const previous = byDevice.get(payload.deviceId)?.record
  const previousOrder = previous ? `${previous.signed.payload.createdAt}:${previous.signed.signature}` : ""
  const nextOrder = `${payload.createdAt}:${record.signed.signature}`
  if (previousOrder >= nextOrder) return false
  byDevice.set(payload.deviceId, { record, receivedAt: Date.now() })
  typingRecords.set(workspaceId, byDevice)
  return true
}

export function loadChatTyping(workspaceId: string): ChatTyping[] {
  const now = Date.now()
  const byDevice = typingRecords.get(workspaceId)
  if (!byDevice) return []
  const result: ChatTyping[] = []
  for (const [deviceId, state] of byDevice) {
    if (now - state.receivedAt >= typingTtlMs) { byDevice.delete(deviceId); continue }
    const payload = state.record.signed.payload
    if (payload.text === "typing") result.push({ personId: payload.personId, deviceId: payload.deviceId })
  }
  return result
}

function message(record: ChatRecord): StoredChatMessage {
  const p = record.signed.payload
  return { id: p.id, workspaceId: p.workspaceId, personId: p.personId, createdAt: p.createdAt, body: p.text, record, ...(p.context ? { context: p.context } : {}) }
}
function member(record: ChatRecord): StoredChatProfile {
  const p = record.signed.payload
  return { workspaceId: p.workspaceId, personId: p.personId, name: p.text, revision: p.revision, record }
}

async function signed(workspaceId: string, kind: "chat-message" | "chat-profile" | "chat-typing", text: string, revision = 0, context?: MessageContext) {
  const { createSignedChatRecord } = await import("./signing")
  return createSignedChatRecord(workspaceId, kind, text, { readOwner, readScope }, revision, context)
}

async function exclusive<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
  return navigator.locks.request(`tincanban-chat-write:${workspaceId}`, action)
}

export async function ensureChatProfile(workspaceId: string, options: { updateName?: boolean } = {}) {
  return exclusive(workspaceId, async () => {
    const { bootstrapIdentity } = await import("../domain/identity")
    const profile = await bootstrapIdentity()
    const own = (await loadChat(workspaceId)).profiles.find(p => p.personId === profile.identity.personId)
    // Background synchronization adopts the admitted shared profile; local names are not rename commands.
    if (own && (!options.updateName || own.name === profile.identity.displayName)) return own
    const value = member(await signed(workspaceId, "chat-profile", profile.identity.displayName, (own?.revision ?? 0) + 1))
    await chatStore.putProfile(value)
    meshTrace("chat.profile.updated", { workspaceId, entityType: "profile", entityId: value.personId,
      recordId: (value.record as ChatRecord).signed.payload.id, phase: own ? "explicit_rename" : "initial",
      bytes: new TextEncoder().encode(JSON.stringify(value.record)).byteLength })
    publish({ workspaceId, added: [], remote: false, history: true })
    return value
  })
}

export async function sendChatMessage(workspaceId: string, body: string, context?: MessageContext) {
  const started = performance.now()
  const scope = await readScope(workspaceId)
  let normalized: MessageContext | undefined
  if (context) {
    normalized = normalizeMessageContext(context, (await loadChat(workspaceId)).messages, scope)
  }
  const timestampMs = Date.now()
  const text = body.trim()
  if (!text || [...text].length > 8000) throw new Error("Message must contain 1–8,000 characters")
  await ensureChatProfile(workspaceId)
  const value = message(await signed(workspaceId, "chat-message", text, 0, normalized))
  meshTrace("chat.submit", { workspaceId, recordId: value.id, timestampMs })
  if (await chatStore.append(value)) {
    meshTrace("chat.persisted", { workspaceId, recordId: value.id, elapsedMs: performance.now() - started, phase: "local" })
    publish({ workspaceId, added: [value], remote: false, history: false })
    return value
  }
  throw new Error("Message could not be retained")
}

export async function sendChatTyping(workspaceId: string, active: boolean) {
  await ensureChatProfile(workspaceId)
  const record = await signed(workspaceId, "chat-typing", active ? "typing" : "idle", Date.now())
  rememberTyping(workspaceId, record)
  publish({ workspaceId, added: [], remote: false, history: false, typing: [record] })
}

export async function exportChat(workspaceId: string, known?: Set<string>, remoteDeviceId?: string): Promise<{ version: 1 | 2; capabilities: string[]; upgradeRequired?: boolean; messages: unknown[]; profiles: unknown[]; typing: unknown[] }> {
  // Existing installations may not yet have received owner credentials. Do not interrupt board sync.
  try { await ensureChatProfile(workspaceId) } catch { /* A received profile will supply owner credentials. */ }
  const snapshot = await loadChat(workspaceId)
  // Advertise capability before transmitting v2. Withhold whole signed records;
  // never strip metadata, re-sign, or mark withheld records as known.
  const compatible = !remoteDeviceId || peerCapabilities.get(await readScope(workspaceId))?.get(remoteDeviceId) === true
  const upgradeRequired = !compatible && snapshot.messages.some(message => message.context !== undefined)
  if (known && known.size > 4096) known.clear()
  const unseen = (value: unknown) => {
    const record = value as ChatRecord
    const key = record.signed.signature
    if (known?.has(key)) return false
    known?.add(key)
    return true
  }
  const activeTyping = [...(typingRecords.get(workspaceId)?.values() ?? [])]
    .filter(state => Date.now() - state.receivedAt < typingTtlMs).map(state => state.record)
  const messages = snapshot.messages.filter(message => compatible || !message.context).map(m => m.record).filter(unseen)
  // Legacy readers reject the whole v2 batch, rather than silently dropping
  // signed contextual records during enrollment or history transfer.
  const version = messages.some(record => (record as ChatRecord).signed.payload.version === 2) ? 2 : 1
  return { version, capabilities: ["contextual-v2"], ...(upgradeRequired ? { upgradeRequired: true } : {}), messages,
    profiles: snapshot.profiles.map(p => p.record).filter(unseen), typing: activeTyping.filter(unseen) }
}

type ChatWire = { version: 1 | 2; capabilities?: string[]; messages: unknown[]; profiles: unknown[]; typing: unknown[] }

function isChatWireObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function parseChatWire(value: unknown): ChatWire {
  if (!isChatWireObject(value)) throw new Error("Invalid chat batch")
  const wire = value
  const { version, messages, profiles, typing, capabilities } = wire
  if ((version !== 1 && version !== 2) || !isUnknownArray(messages) || !isUnknownArray(profiles)) {
    throw new Error("Invalid chat batch")
  }
  if (typing !== undefined && !isUnknownArray(typing)) throw new Error("Invalid chat batch")
  if (capabilities !== undefined && (!isUnknownArray(capabilities) || capabilities.length > 16 || capabilities.some(item => typeof item !== "string" || item.length > 64))) throw new Error("Invalid chat capabilities")
  const activeTyping: unknown[] = typing === undefined ? [] : typing
  if (messages.length > 2000 || profiles.length > 512 || activeTyping.length > 512) {
    throw new Error("Invalid chat batch")
  }
  if (new TextEncoder().encode(JSON.stringify(wire)).byteLength > 8 * 1024 * 1024) {
    throw new Error("Invalid chat batch")
  }
  const validCapabilities = isUnknownArray(capabilities)
    ? capabilities.filter((item): item is string => typeof item === "string")
    : undefined
  return { version, capabilities: validCapabilities, messages, profiles, typing: activeTyping }
}

function rejectRecord(workspaceId: string, section: string, error: unknown): void {
  console.warn("[tincanban.chat]", JSON.stringify({
    event: "record.rejected", workspaceId, section,
    reason: error instanceof Error ? error.message : String(error),
  }))
}

async function verifiedRecords(
  items: unknown[],
  kind: ChatRecord["signed"]["payload"]["kind"],
  scope: string,
  owner: string,
  workspaceId: string,
): Promise<ChatRecord[]> {
  const records: ChatRecord[] = []
  for (const item of items) {
    try {
      const record = await verifyChatRecord(item, scope, owner, workspaceId)
      if (record.signed.payload.kind !== kind) throw new Error(`Invalid ${kind}`)
      records.push(record)
    } catch (error) {
      rejectRecord(workspaceId, kind, error)
    }
  }
  return records
}

export async function receiveChat(workspaceId: string, value: unknown, history: boolean, remoteDeviceId?: string) {
  const started = performance.now()
  const timestampMs = Date.now()
  const wire = parseChatWire(value)
  const owner = await readOwner(workspaceId)
  const scope = await readScope(workspaceId)
  if (remoteDeviceId) {
    const capabilities = peerCapabilities.get(scope) ?? new Map<string, boolean>()
    capabilities.set(remoteDeviceId, wire.capabilities?.includes("contextual-v2") === true)
    peerCapabilities.set(scope, capabilities)
  }
  const profileRecords = await verifiedRecords(wire.profiles, "chat-profile", scope, owner, workspaceId)
  const messageRecords = await verifiedRecords(wire.messages, "chat-message", scope, owner, workspaceId)
  const typingRecords = await verifiedRecords(wire.typing, "chat-typing", scope, owner, workspaceId)
  const profiles = profileRecords.map(member)
  const messages = messageRecords.map(message)
  const typing = typingRecords.filter(record => rememberTyping(workspaceId, record))
  const result = await chatStore.merge(scope, messages, profiles)
  for (const message of result.added) {
    meshTrace("chat.received", { workspaceId, recordId: message.id, timestampMs, peerId: remoteDeviceId })
    meshTrace("chat.persisted", { workspaceId, recordId: message.id, elapsedMs: performance.now() - started, phase: "remote", peerId: remoteDeviceId })
  }
  if (result.changed || typing.length) publish({ workspaceId, added: result.added, remote: true, history, typing })
}
