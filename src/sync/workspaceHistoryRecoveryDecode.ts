import { validateBlobDescriptor, verifyBlobBytes, type BlobDescriptor } from "@meta-uber/mesh-blob"
import { canonicalizeJson, fromBase64Url, sha256Base64Url, toBase64Url } from "../domain/identity"
import type { HistoryRecoveryRecord } from "./historyRecoveryArchive"
import { WORKSPACE_RECOVERY_STORES, type WorkspaceRecoveryStoreName } from "../workspaceRecoveryStores"

const STORES = WORKSPACE_RECOVERY_STORES
export type { WorkspaceRecoveryStoreName } from "../workspaceRecoveryStores"
type StoreName = WorkspaceRecoveryStoreName
export type WorkspaceRecoveryJournalRow = { id: string; value: unknown }
type BinaryReference = { path: string[]; id: string; byteLength: number }
type EvidenceGroup = { category: string; id: string; count: number; parts: Uint8Array[]; size: number }
type DecodedAttachment = { descriptor: BlobDescriptor; bytes: Uint8Array }
export type WorkspaceRecoveryJournal = Record<StoreName, WorkspaceRecoveryJournalRow[]>
type Journal = WorkspaceRecoveryJournal
const encoder = new TextEncoder(), decoder = new TextDecoder("utf-8", { fatal: true })
const MAX_BYTES = 512 * 1024 * 1024, MAX_RECORDS = 1_000_000, MAX_DEPTH = 64

function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      fields.some(field => !Object.hasOwn(value, field))) throw new Error("Invalid workspace recovery evidence metadata")
}
function strictBase64(value: unknown, max = 256 * 1024): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length > Math.ceil(max * 4 / 3)) {
    throw new Error("Invalid workspace recovery evidence encoding")
  }
  const bytes = fromBase64Url(value)
  if (bytes.length > max || toBase64Url(bytes) !== value) throw new Error("Invalid workspace recovery evidence encoding")
  return new Uint8Array(bytes)
}
async function hash(value: unknown): Promise<string> { return sha256Base64Url(encoder.encode(canonicalizeJson(value))) }
function storeCategory(category: string): { store: StoreName; kind: "bytes" | "metadata" } | undefined {
  for (const store of STORES) {
    if (category === store + "-bytes") return { store, kind: "bytes" }
    if (category === store + "-metadata") return { store, kind: "metadata" }
  }
}
function groupKey(category: string, id: string): string { return category + "\0" + id }

function validateTree(value: unknown, depth = 0, counter = { nodes: 0 }): void {
  if (++counter.nodes > MAX_RECORDS || depth > MAX_DEPTH) throw new Error("Workspace recovery metadata structure exceeds limits")
  if (value === null || isJsonPrimitive(value)) return
  if (Array.isArray(value)) { for (const child of value) validateTree(child, depth + 1, counter); return }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error("Unsupported workspace recovery metadata value")
  }
  for (const child of Object.values(value)) validateTree(child, depth + 1, counter)
}
function isJsonPrimitive(value: unknown): value is null | string | boolean | number {
  return value === null || typeof value === "string" || typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value)
}
function validatePath(path: unknown): asserts path is string[] {
  if (!Array.isArray(path) || path.length < 1 || path.length > MAX_DEPTH || path.some(segment => typeof segment !== "string" ||
      segment.length > 1024 || segment.includes("\0"))) throw new Error("Invalid workspace recovery binary path")
}
function getPath(root: unknown, path: string[]): unknown {
  let value = root
  for (const segment of path) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment) || Number(segment) >= value.length || !Object.hasOwn(value, Number(segment))) {
        throw new Error("Workspace recovery binary path does not exist")
      }
      value = value[Number(segment)]
    } else if (value && typeof value === "object" && Object.hasOwn(value, segment)) {
      value = (value as Record<string, unknown>)[segment]
    } else throw new Error("Workspace recovery binary path does not exist")
  }
  return value
}
function setPath(root: unknown, path: string[], value: Uint8Array): void {
  let parent = root
  for (const segment of path.slice(0, -1)) {
    if (Array.isArray(parent)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment) || Number(segment) >= parent.length || !Object.hasOwn(parent, Number(segment))) {
        throw new Error("Workspace recovery binary path does not exist")
      }
      parent = parent[Number(segment)]
    } else if (parent && typeof parent === "object" && Object.hasOwn(parent, segment)) {
      parent = (parent as Record<string, unknown>)[segment]
    } else throw new Error("Workspace recovery binary path does not exist")
  }
  const last = path.at(-1)!
  if (Array.isArray(parent)) return setArrayPathValue(parent, last, value)
  if (isNullObjectField(parent, last)) {
    Object.defineProperty(parent, last, { configurable: true, enumerable: true, writable: true, value })
    return
  }
  throw new Error("Workspace recovery binary placeholder mismatch")
}
function setArrayPathValue(parent: unknown[], last: string, value: Uint8Array): void {
  const index = Number(last)
  if (!/^(0|[1-9][0-9]*)$/.test(last) || index >= parent.length || parent[index] !== null) throw new Error("Workspace recovery binary placeholder mismatch")
  parent[index] = value
}
function isNullObjectField(parent: unknown, key: string): parent is Record<string, unknown> {
  return Boolean(parent && typeof parent === "object" && !Array.isArray(parent) && Object.hasOwn(parent, key) &&
    (parent as Record<string, unknown>)[key] === null)
}
function parseCanonicalJson(bytes: Uint8Array): unknown {
  const text = decoder.decode(bytes), value: unknown = JSON.parse(text)
  if (canonicalizeJson(value) !== text) throw new Error("Non-canonical workspace recovery metadata")
  validateTree(value)
  return value
}
function allPathsDisjoint(paths: string[][]): void {
  type Node = { terminal: boolean; children: Map<string, Node> }
  const root: Node = { terminal: false, children: new Map() }
  for (const path of paths) {
    let node = root
    for (const segment of path) {
      if (node.terminal) throw new Error("Overlapping workspace recovery binary paths")
      let child = node.children.get(segment)
      if (!child) { child = { terminal: false, children: new Map() }; node.children.set(segment, child) }
      node = child
    }
    if (node.terminal) throw new Error("Duplicate workspace recovery binary path")
    if (node.children.size) throw new Error("Overlapping workspace recovery binary paths")
    node.terminal = true
  }
}
function consumeGroup(groups: Map<string, EvidenceGroup>, category: string, id: string): Uint8Array {
  const key = groupKey(category, id), group = groups.get(key)
  if (!group) throw new Error("Workspace recovery evidence part is missing")
  groups.delete(key)
  const bytes = new Uint8Array(group.size)
  let offset = 0
  for (const part of group.parts) { bytes.set(part, offset); offset += part.length; part.fill(0) }
  return bytes
}
function parseMetadata(bytes: Uint8Array): { record: Record<string, unknown>; binaryFields: BinaryReference[] } {
  const value: unknown = parseCanonicalJson(bytes)
  exact(value, ["record", "binaryFields"])
  if (!value.record || typeof value.record !== "object" || Array.isArray(value.record) || !Array.isArray(value.binaryFields)) {
    throw new Error("Invalid workspace recovery journal row")
  }
  return { record: value.record as Record<string, unknown>, binaryFields: value.binaryFields as BinaryReference[] }
}

type AttachmentParts = Map<string, { descriptor?: BlobDescriptor; bytes?: Uint8Array }>

function assertEvidenceSequence(record: Extract<HistoryRecoveryRecord, { kind: "local-evidence-part" }>): void {
    const categoryInfo = storeCategory(record.category), extra = ["workspace-control", "publication-metadata", "attachment-metadata",
      "attachment-bytes", "workspace-source", "peer-history-source", "peer-history-object"].includes(record.category)
    if (!categoryInfo && !extra) throw new Error("Unknown workspace recovery evidence category")
    if (!record.id || record.id.length > 512 || !Number.isSafeInteger(record.partCount) || record.partCount < 1 ||
        record.partCount > MAX_RECORDS || !Number.isSafeInteger(record.partIndex) || record.partIndex < 0 ||
        record.partIndex >= record.partCount) throw new Error("Invalid workspace recovery evidence part sequence")
}

type GroupTracker = { activeGroup?: string; closed: Set<string> }
function closeEvidenceGroup(tracker: GroupTracker): void {
  if (tracker.activeGroup) tracker.closed.add(tracker.activeGroup)
  tracker.activeGroup = undefined
}
function selectEvidenceGroup(tracker: GroupTracker, key: string): void {
  if (tracker.activeGroup === key) return
  closeEvidenceGroup(tracker)
  if (tracker.closed.has(key)) throw new Error("Workspace recovery evidence parts are not contiguous")
  tracker.activeGroup = key
}

function collectEvidenceGroups(records: HistoryRecoveryRecord[], workspaceId: string): Map<string, EvidenceGroup> {
  const groups = new Map<string, EvidenceGroup>()
  const tracker: { activeGroup?: string; closed: Set<string> } = { closed: new Set() }
  let totalBytes = 0, partTotal = 0
  for (const record of records) {
    if (record.kind !== "local-evidence-part") {
      closeEvidenceGroup(tracker)
      if (record.kind === "archive-source" && record.workspaceId !== workspaceId) throw new Error("Recovery archive belongs to another workspace")
      if (record.kind === "history-recovery-manifest" && record.workspaceId !== workspaceId) throw new Error("Recovery manifest belongs to another workspace")
      continue
    }
    assertEvidenceSequence(record)
    const bytes = strictBase64(record.data)
    totalBytes += bytes.length
    if (totalBytes > MAX_BYTES || ++partTotal > MAX_RECORDS) throw new Error("Workspace recovery evidence exceeds limits")
    const key = groupKey(record.category, record.id)
    selectEvidenceGroup(tracker, key)
    let group = groups.get(key)
    if (!group) {
      if (record.partIndex !== 0) throw new Error("Workspace recovery evidence part sequence is incomplete")
      group = { category: record.category, id: record.id, count: record.partCount, parts: [], size: 0 }
      groups.set(key, group)
    }
    if (group.count !== record.partCount || group.parts.length !== record.partIndex) throw new Error("Workspace recovery evidence part ordering mismatch")
    group.parts.push(bytes); group.size += bytes.length
  }
  for (const group of groups.values()) if (group.parts.length !== group.count) throw new Error("Workspace recovery evidence is truncated")

  return groups
}

async function assertBinaryReferences(groupId: string, record: Record<string, unknown>, binaryFields: BinaryReference[]): Promise<void> {
      const seenIds = new Set<string>(), paths: string[][] = []
      for (const field of binaryFields) {
        exact(field, ["path", "id", "byteLength"])
        validatePath(field.path)
        if (typeof field.id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(field.id) || !Number.isSafeInteger(field.byteLength) ||
            field.byteLength < 0 || field.byteLength > MAX_BYTES || seenIds.has(field.id) ||
            await hash([groupId, field.path]) !== field.id) throw new Error("Invalid workspace recovery binary reference")
        seenIds.add(field.id); paths.push(field.path)
        if (getPath(record, field.path) !== null) throw new Error("Workspace recovery binary placeholder mismatch")
      }
      allPathsDisjoint(paths)
}

async function decodeJournal(groups: Map<string, EvidenceGroup>, workspaceId: string): Promise<Journal> {
  const journal = {} as Journal
  for (const store of STORES) journal[store] = []
  let rowCount = 0
  for (const store of STORES) {
    const metadataGroups = [...groups.values()].filter(group => group.category === store + "-metadata")
    for (const group of metadataGroups) {
      if (++rowCount > MAX_RECORDS) throw new Error("Too many workspace recovery journal rows")
      const metadataBytes = consumeGroup(groups, store + "-metadata", group.id)
      const { record, binaryFields } = parseMetadata(metadataBytes)
      metadataBytes.fill(0)
      if (record.workspaceId !== workspaceId || typeof record.id !== "string" || !record.id || record.id.length > 1024 ||
          await hash([store, record.id]) !== group.id) throw new Error("Workspace recovery row binding mismatch")
      await assertBinaryReferences(group.id, record, binaryFields)
      for (const field of binaryFields) {
        const binary = consumeGroup(groups, store + "-bytes", field.id)
        if (binary.length !== field.byteLength) { binary.fill(0); throw new Error("Workspace recovery binary length mismatch") }
        setPath(record, field.path, binary)
      }
      journal[store].push({ id: record.id, value: record })
    }
    for (const group of [...groups.values()]) if (group.category === store + "-bytes") {
      throw new Error("Unreferenced workspace recovery journal bytes")
    }
  }

  return journal
}

function assertPeerSourceSignatureRouting(signedJson: Uint8Array, workspaceId: string, baselineId: string): void {
      let envelope: unknown
      try { envelope = JSON.parse(decoder.decode(signedJson)) } catch { throw new Error("Peer history source signature is malformed") }
      const payload = envelope && typeof envelope === "object" && !Array.isArray(envelope)
        ? (envelope as Record<string, unknown>).payload : undefined
      if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
          (payload as Record<string, unknown>).workspaceId !== workspaceId ||
          (payload as Record<string, unknown>).baselineId !== baselineId) {
        throw new Error("Peer history source signature routing is invalid")
      }
}

function readPeerSourceMetadata(encoded: Uint8Array, workspaceId: string, baselineId: string) {
      const value: unknown = parseCanonicalJson(encoded)
      exact(value, ["version", "workspaceId", "baselineId", "signedJson"])
      if (value.version !== 1 || value.workspaceId !== workspaceId || value.baselineId !== baselineId ||
          typeof value.baselineId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.baselineId)) {
        throw new Error("Peer history source routing is invalid")
      }
      const signedJson = strictBase64(value.signedJson, 256 * 1024)
      if (!signedJson.length) throw new Error("Peer history source signature is empty")
  assertPeerSourceSignatureRouting(signedJson, workspaceId, baselineId)
  return { value, signedJson }
}

async function decodePeerSources(groups: Map<string, EvidenceGroup>, workspaceId: string, journal: Journal,
  auxiliary: Map<string, unknown>): Promise<Set<string>> {
  const peerSources = new Map<string, { value: Record<string, unknown>; bytes: Uint8Array }>()
  for (const group of [...groups.values()].filter(value => value.category === "peer-history-source")) {
    const encoded = consumeGroup(groups, group.category, group.id)
    try {
      const { value, signedJson } = readPeerSourceMetadata(encoded, workspaceId, group.id)
      const original = journal.receivedBaselines.find(row => {
        const value = row.value as { id?: unknown; workspaceId?: unknown; baselineId?: unknown; state?: unknown; signedJson?: unknown }
        const stagedWithoutCachedId = value?.baselineId === undefined && value.state === "staged" &&
          typeof value.id === "string" && value.id.startsWith(`${workspaceId}:staged:`)
        return value?.workspaceId === workspaceId && (value.baselineId === group.id || stagedWithoutCachedId) &&
          value.signedJson instanceof Uint8Array
      })?.value as { signedJson: Uint8Array } | undefined
      if (!original || original.signedJson.length !== signedJson.length ||
          original.signedJson.some((byte, index) => byte !== signedJson[index])) {
        throw new Error("Peer history source does not match the exact saved baseline signature")
      }
      peerSources.set(group.id, { value: value as Record<string, unknown>, bytes: signedJson })
      auxiliary.set(`peer-history-source/${group.id}`, value)
    } finally { encoded.fill(0) }
  }

  return new Set(peerSources.keys())
}

async function decodePeerObjects(groups: Map<string, EvidenceGroup>, peerSources: Set<string>, auxiliary: Map<string, unknown>): Promise<void> {
  for (const group of [...groups.values()].filter(value => value.category === "peer-history-object")) {
    const objectBytes = consumeGroup(groups, group.category, group.id)
    const separator = group.id.indexOf(":")
    const baselineId = group.id.slice(0, separator), objectId = group.id.slice(separator + 1)
    if (separator <= 0 || !peerSources.has(baselineId) || !/^[A-Za-z0-9_-]{43}$/.test(objectId) ||
        objectBytes.length > 256 * 1024 || await sha256Base64Url(objectBytes) !== objectId) {
      objectBytes.fill(0)
      throw new Error("Peer history object is orphaned or has invalid content hash")
    }
    auxiliary.set(`peer-history-object/${group.id}`, objectBytes)
  }

 }

function captureAuxiliaryMetadata(group: EvidenceGroup, value: unknown, attachmentsById: AttachmentParts): void {
      if (group.category === "workspace-control") {
        if (group.id !== "access") throw new Error("Invalid workspace control evidence key")
        exact(value, ["authorization", "authority", "credential"])
      } else if (group.category === "publication-metadata") {
        if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "publicationId") ||
            (value as Record<string, unknown>).publicationId !== group.id) throw new Error("Publication recovery metadata binding mismatch")
      } else if (group.category === "attachment-metadata") {
        exact(value, ["descriptor"])
        const descriptor = validateBlobDescriptor((value as { descriptor: BlobDescriptor }).descriptor)
        if (descriptor.blobId !== group.id) throw new Error("Attachment recovery metadata binding mismatch")
        const entry = attachmentsById.get(group.id) ?? {}
        if (entry.descriptor) throw new Error("Duplicate recovery attachment metadata")
        entry.descriptor = structuredClone(descriptor); attachmentsById.set(group.id, entry)
      }
}

function decodeAuxiliaryGroups(groups: Map<string, EvidenceGroup>, auxiliary: Map<string, unknown>, attachmentsById: AttachmentParts): void {
  for (const group of [...groups.values()]) {
    const serialized = consumeGroup(groups, group.category, group.id)
    if (group.category === "peer-history-source" || group.category === "peer-history-object") {
      throw new Error("Peer history evidence was not consumed")
    }
    if (group.category === "attachment-bytes" || group.category === "workspace-source") {
      if (group.category === "workspace-source" && group.id !== "raw") throw new Error("Invalid workspace source evidence key")
      const entry = attachmentsById.get(group.id) ?? {}
      if (group.category === "attachment-bytes") {
        if (entry.bytes) throw new Error("Duplicate recovery attachment bytes")
        entry.bytes = serialized; attachmentsById.set(group.id, entry)
      }
      auxiliary.set(group.category + "/" + group.id, serialized)
    } else {
      const value = parseCanonicalJson(serialized); serialized.fill(0)
      captureAuxiliaryMetadata(group, value, attachmentsById)
      auxiliary.set(group.category + "/" + group.id, value)
    }
  }
 }

async function verifyAttachments(attachmentsById: AttachmentParts): Promise<DecodedAttachment[]> {
  const attachments: DecodedAttachment[] = []
  for (const [id, entry] of attachmentsById) {
    if (!entry.descriptor || !entry.bytes) throw new Error("Recovery attachment is missing its descriptor or bytes")
    const verified = await verifyBlobBytes(entry.descriptor, entry.bytes)
    if (entry.descriptor.blobId !== id) throw new Error("Recovery attachment ID mismatch")
    attachments.push({ descriptor: entry.descriptor, bytes: verified })
  }
  return attachments
}

/** Decode authenticated private backup rows into detached candidate data; performs no persistence or admission. */
export async function decodeWorkspaceRecoveryEvidence(records: HistoryRecoveryRecord[], workspaceId: string): Promise<{
  journal: Journal; auxiliary: Map<string, unknown>; attachments: DecodedAttachment[]
}> {
  if (!workspaceId || workspaceId.length > 256 || !Array.isArray(records) || records.length > MAX_RECORDS) {
    throw new Error("Invalid workspace recovery evidence input")
  }
  const groups = collectEvidenceGroups(records, workspaceId)
  const journal = await decodeJournal(groups, workspaceId)
  const auxiliary = new Map<string, unknown>(), attachmentsById: AttachmentParts = new Map()
  const peerSources = await decodePeerSources(groups, workspaceId, journal, auxiliary)
  await decodePeerObjects(groups, peerSources, auxiliary)
  decodeAuxiliaryGroups(groups, auxiliary, attachmentsById)
  const attachments = await verifyAttachments(attachmentsById)
  return { journal, auxiliary, attachments }
}
