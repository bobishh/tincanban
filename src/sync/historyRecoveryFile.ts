import { canonicalizeJson, fromBase64Url, identitySeedFromPrivateKey, openIdentityRecoveryEnvelope,
  profileFromIdentitySeedForDevice, sha256Base64Url, toBase64Url, type IdentityRecoveryEnvelope } from "@meta-uber/mesh-identity"
import { captureEncryptedArchiveObject, openArchiveObject, sealArchiveObject,
  type ArchiveEncryptionScope, type EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import { parseIdentityRecoveryFile, openIdentityDeviceRecovery,
  type IdentityDeviceRecoveryFile } from "./identityDeviceRecoveryCodec"
import { isValidBlobId } from "@meta-uber/mesh-blob"
import { captureMissingPeerObjects, type HistoryRecoveryEvidencePart, type HistoryRecoveryManifest, type HistoryRecoveryRecord } from "./historyRecoveryArchive"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const FILE_LIMIT = 1024 * 1024 * 1024
const TOTAL_LIMIT = 512 * 1024 * 1024
const RECORD_LIMIT = 4 * 1024 * 1024
const PART_LIMIT = 256 * 1024
const SEED_INFO = encoder.encode("tincanban/history-recovery/v1")
const TRANSCRIPT_START = "tincanban/history-recovery/v1"

export type HistoryRecoveryFileHeader = {
  kind: "tincanban-history-recovery"; version: 1; workspaceId: string
  identityRecovery: IdentityDeviceRecoveryFile; salt: string
}
type FragmentRow = { kind: "fragment"; recordIndex: number; partIndex: number; partCount: number
  objectId: string; ciphertextId: string; object: EncryptedArchiveObject }
type JsonLine = { text: string; bytes: number }
type WriterState = { previous: string; totalBytes: number; recordIndex: number; manifestSeen: boolean; encryptedBytes: number;
  evidencePartTotal: number; sourceIds: Set<string>; objectIds: Set<string>; sourceEpochs: Map<string, Set<number>>;
  evidenceStates: Map<string, { next: number; count: number }> }
type ReaderState = { transcript: string; encryptedBytes: number; recoveredRecordBytes: number; evidencePartTotal: number;
  sourceIds: Set<string>; objectIds: Set<string>; sourceEpochs: Map<string, Set<number>>;
  evidenceStates: Map<string, { next: number; count: number }>; completed: boolean }

function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      fields.some(field => !Object.hasOwn(value, field))) throw new Error("Invalid history recovery file row")
}
function recordShape(record: HistoryRecoveryRecord): void {
  if (record.kind === "archive-source") exact(record, ["kind", "id", "workspaceId", "scopeId", "keyEpoch", "key", "roots", "signedJson", "authorityEvidence"])
  else if (record.kind === "encrypted-object") exact(record, ["kind", "scopeId", "ciphertextId", "object"])
  else if (record.kind === "local-evidence-part") exact(record, ["kind", "category", "id", "partIndex", "partCount", "data"])
  else if (record.kind === "history-recovery-manifest") {
    const fields = ["kind", "version", "workspaceId", "coverage", "sourceCount", "objectCount", "encryptedBytes", "transcriptDigest", "missingObjects", "unresolvedDirectories"]
    if (Object.hasOwn(record, "evidencePartCount")) fields.push("evidencePartCount")
    if (Object.hasOwn(record, "missingAttachmentIds")) fields.push("missingAttachmentIds")
    if (Object.hasOwn(record, "missingPeerObjects")) fields.push("missingPeerObjects")
    exact(record, fields)
  } else throw new Error("Unknown history recovery record")
}
function validateManifest(record: HistoryRecoveryManifest): void {
  const extended = record as HistoryRecoveryManifest & { missingAttachmentIds?: string[] }
  const missingAttachments = extended.missingAttachmentIds ?? []
  const missingPeerObjects = Object.hasOwn(record, "missingPeerObjects") ? captureMissingPeerObjects(record.missingPeerObjects) : []
  const incomplete = record.missingObjects.length > 0 || record.unresolvedDirectories.length > 0 || missingAttachments.length > 0 || missingPeerObjects.length > 0
  validateManifestCounts(record, extended, missingAttachments, incomplete)
  validateMissingAttachments(missingAttachments)
  validateMissingObjects(record.missingObjects)
  validateUnresolvedDirectories(record.unresolvedDirectories)
}
function validateManifestCounts(record: HistoryRecoveryManifest, extended: HistoryRecoveryManifest & { missingAttachmentIds?: string[] },
  missingAttachments: string[], incomplete: boolean): void {
  if (record.version !== 1 || !record.workspaceId || record.workspaceId.length > 256 ||
      !["complete", "incomplete"].includes(record.coverage) || record.coverage !== (incomplete ? "incomplete" : "complete")) {
    throw new Error("Invalid history recovery manifest")
  }
  validateManifestNumericCounts(record, extended)
  validateManifestArrayCounts(record, extended, missingAttachments)
}
function validateManifestNumericCounts(record: HistoryRecoveryManifest,
  extended: HistoryRecoveryManifest & { missingAttachmentIds?: string[] }): void {
  if (!boundedInteger(record.sourceCount, 0, 256) || !boundedInteger(record.objectCount, 0, 1_048_576) ||
      !boundedInteger(record.encryptedBytes, 0, TOTAL_LIMIT)) throw new Error("Invalid history recovery manifest")
  if (extended.evidencePartCount !== undefined && !boundedInteger(extended.evidencePartCount, 1, 1_048_576)) {
    throw new Error("Invalid history recovery evidence count")
  }
}
function validateManifestArrayCounts(record: HistoryRecoveryManifest, extended: HistoryRecoveryManifest & { missingAttachmentIds?: string[] },
  missingAttachments: string[]): void {
  if (!Array.isArray(record.missingObjects) || record.missingObjects.length > 4096 ||
      !Array.isArray(record.unresolvedDirectories) || record.unresolvedDirectories.length > 4096 ||
      !Array.isArray(missingAttachments) || missingAttachments.length > 1024 ||
      extended.missingAttachmentIds !== undefined && missingAttachments.length === 0) throw new Error("Invalid history recovery manifest")
}
function boundedInteger(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}
function validateMissingAttachments(missingAttachments: string[]): void {
  let previous = ""
  for (const id of missingAttachments) {
    if (typeof id !== "string" || !isValidBlobId(id) || id <= previous) {
      throw new Error("Invalid or non-canonical missing attachment identifier")
    }
    previous = id
  }
}
function validateMissingObjects(entries: HistoryRecoveryManifest["missingObjects"]): void {
  for (const entry of entries) {
    exact(entry, ["scopeId", "ciphertextId"])
    if (typeof entry.scopeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.scopeId) ||
        typeof entry.ciphertextId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(entry.ciphertextId)) throw new Error("Invalid missing history object")
  }
}
function validateUnresolvedDirectories(entries: HistoryRecoveryManifest["unresolvedDirectories"]): void {
  for (const entry of entries) {
    exact(entry, ["sourceId", "ciphertextId"])
    if (typeof entry.sourceId !== "string" || !entry.sourceId || entry.sourceId.length > 256 ||
        typeof entry.ciphertextId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(entry.ciphertextId)) throw new Error("Invalid unresolved history directory")
  }
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || !value.length || encoder.encode(value).length > max ||
      [...value].some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff })) {
    throw new Error("Invalid history recovery file text")
  }
}
function bytes(value: string, expected: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid history recovery file encoding")
  const decoded = fromBase64Url(value)
  if (decoded.length !== expected || toBase64Url(decoded) !== value) throw new Error("Invalid history recovery file encoding")
  return new Uint8Array(decoded)
}
function validateBoundedBytes(value: string, max: number): void {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length > Math.ceil(max * 4 / 3)) throw new Error("Invalid history recovery encoding")
  const decoded = fromBase64Url(value)
  if (decoded.length > max || toBase64Url(decoded) !== value) throw new Error("Invalid history recovery encoding")
  decoded.fill(0)
}
function validateEncodedBytes(value: string, expected: number): void {
  const decoded = bytes(value, expected)
  decoded.fill(0)
}
function validateEvidencePart(value: HistoryRecoveryEvidencePart, states: Map<string, { next: number; count: number }>): void {
  if (!validEvidencePartShape(value)) throw new Error("Invalid local history recovery evidence part")
  const decoded = fromBase64Url(value.data)
  if (decoded.length > PART_LIMIT || toBase64Url(decoded) !== value.data) throw new Error("Invalid local history recovery evidence encoding")
  decoded.fill(0)
  const key = `${value.category}/${value.id}`, state = states.get(key) ?? { next: 0, count: value.partCount }
  if (state.count !== value.partCount || state.next !== value.partIndex) throw new Error("Out-of-order local history recovery evidence")
  state.next++
  states.set(key, state)
}
function validEvidencePartShape(value: HistoryRecoveryEvidencePart): boolean {
  return value.kind === "local-evidence-part" && /^[A-Za-z0-9_-]{1,64}$/.test(value.category) &&
      typeof value.id === "string" && Boolean(value.id) && value.id.length <= 512 && Number.isSafeInteger(value.partCount) &&
      value.partCount >= 1 && value.partCount <= 1_048_576 && Number.isSafeInteger(value.partIndex) && value.partIndex >= 0 &&
      value.partIndex < value.partCount && typeof value.data === "string" && /^[A-Za-z0-9_-]*$/.test(value.data) &&
      value.data.length <= Math.ceil(PART_LIMIT * 4 / 3)
}
function evidenceCount(states: Map<string, { next: number; count: number }>): number {
  for (const state of states.values()) if (state.next !== state.count) throw new Error("Incomplete local history recovery evidence")
  return [...states.values()].reduce((sum, state) => sum + state.count, 0)
}
function canonical(value: unknown): string { return canonicalizeJson(value) }
async function digest(bytes: Uint8Array): Promise<string> { return sha256Base64Url(bytes) }
async function transcriptNext(previous: string, record: Exclude<HistoryRecoveryRecord, HistoryRecoveryManifest>): Promise<string> {
  return digest(encoder.encode(canonical([previous, await digest(encoder.encode(canonical(record)))])))
}
async function validateWriterRecord(record: HistoryRecoveryRecord, workspaceId: string, state: WriterState): Promise<void> {
  if (record.kind === "history-recovery-manifest") return validateWriterManifest(record, workspaceId, state)
  state.previous = await transcriptNext(state.previous, record)
  if (record.kind === "archive-source") return validateWriterSource(record, workspaceId, state)
  if (record.kind === "encrypted-object") return validateWriterObject(record, state)
  if (record.kind === "local-evidence-part") {
    validateEvidencePart(record, state.evidenceStates)
    if (++state.evidencePartTotal > 1_048_576) throw new Error("Too many local history recovery evidence parts")
    return
  }
  throw new Error("Unknown history recovery record")
}
function validateWriterManifest(record: HistoryRecoveryManifest, workspaceId: string, state: WriterState): void {
  validateManifest(record)
  if (record.workspaceId !== workspaceId || record.version !== 1 || record.transcriptDigest !== state.previous ||
      record.sourceCount !== state.sourceIds.size || record.objectCount !== state.objectIds.size ||
      record.encryptedBytes !== state.encryptedBytes || (record.evidencePartCount ?? 0) !== evidenceCount(state.evidenceStates) ||
      !Number.isSafeInteger(record.sourceCount) || record.sourceCount < 0 || !Number.isSafeInteger(record.objectCount) || record.objectCount < 0) {
    throw new Error("History recovery final manifest mismatch")
  }
  state.manifestSeen = true
}
function validateWriterSource(record: Extract<HistoryRecoveryRecord, { kind: "archive-source" }>, workspaceId: string, state: WriterState): void {
  if (record.workspaceId !== workspaceId || state.sourceIds.has(record.id) || !record.id || record.id.length > 256 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(record.scopeId) || !Number.isSafeInteger(record.keyEpoch) || record.keyEpoch < 1 ||
      record.roots.length < 1 || record.roots.length > 4 || encoder.encode(canonical(record.authorityEvidence)).length > 2 * 1024 * 1024) {
    throw new Error("Invalid history recovery archive source")
  }
  validateEncodedBytes(record.key, 32)
  validateBoundedBytes(record.signedJson, 256 * 1024)
  state.sourceIds.add(record.id)
  if (state.sourceIds.size > 256) throw new Error("Too many history recovery sources")
  const epochs = state.sourceEpochs.get(record.scopeId) ?? new Set<number>()
  epochs.add(record.keyEpoch)
  state.sourceEpochs.set(record.scopeId, epochs)
}
async function validateWriterObject(record: Extract<HistoryRecoveryRecord, { kind: "encrypted-object" }>, state: WriterState): Promise<void> {
  const identity = `${record.scopeId}/${record.ciphertextId}`
  if (state.objectIds.has(identity) || !state.sourceEpochs.get(record.scopeId)?.has(record.object.keyEpoch)) {
    throw new Error("Duplicate or unbound history recovery archive object")
  }
  const object = captureEncryptedArchiveObject(record.object, record.scopeId)
  const canonicalObject = canonical(object), encoded = encoder.encode(canonicalObject)
  if (await digest(encoded) !== record.ciphertextId) throw new Error("History recovery ciphertext hash mismatch")
  state.encryptedBytes += encoded.length
  if (state.encryptedBytes > TOTAL_LIMIT || state.objectIds.size >= 1_048_576) throw new Error("History recovery encrypted object limit exceeded")
  state.objectIds.add(identity)
}
async function appendRecordFragments(recordBytes: Uint8Array, state: WriterState, scope: ArchiveEncryptionScope,
  workspaceId: string, headerHash: string, output: BlobPart[], currentOutputBytes: number): Promise<number> {
  const count = Math.max(1, Math.ceil(recordBytes.length / PART_LIMIT))
  let outputBytes = currentOutputBytes
  for (let index = 0; index < count; index++) {
    const fragment = recordBytes.slice(index * PART_LIMIT, Math.min(recordBytes.length, (index + 1) * PART_LIMIT))
    const objectId = await digest(fragment)
    const sealed = await sealArchiveObject(scope, binding(workspaceId, headerHash, state.recordIndex, objectId, index, count), fragment)
    const row: FragmentRow = { kind: "fragment", recordIndex: state.recordIndex, partIndex: index, partCount: count,
      objectId, ciphertextId: sealed.ciphertextId, object: sealed.object }
    const line = encoder.encode(canonical(row) + "\n")
    if (outputBytes + line.byteLength > FILE_LIMIT) throw new Error("History recovery file exceeds size limit")
    output.push(line)
    outputBytes += line.byteLength
    fragment.fill(0)
  }
  return outputBytes
}
async function acceptOpenedRecord(plain: Uint8Array, workspaceId: string, records: HistoryRecoveryRecord[], state: ReaderState): Promise<void> {
  if (plain.length > RECORD_LIMIT) throw new Error("History recovery record exceeds size limit")
  const serialized = decoder.decode(plain), value: unknown = JSON.parse(serialized)
  if (canonical(value) !== serialized) throw new Error("Non-canonical history recovery record")
  const parsed = structuredClone(value) as HistoryRecoveryRecord
  recordShape(parsed)
  if (parsed.kind === "history-recovery-manifest") validateReaderManifest(parsed, workspaceId, state)
  else await validateReaderArchiveRecord(parsed, workspaceId, state)
  state.recoveredRecordBytes += plain.length
  if (state.recoveredRecordBytes > TOTAL_LIMIT) throw new Error("History recovery records exceed total size limit")
  records.push(parsed)
  if (records.length > 2_097_313) throw new Error("Too many history recovery records")
}
function validateReaderManifest(record: HistoryRecoveryManifest, workspaceId: string, state: ReaderState): void {
  validateManifest(record)
  if (record.workspaceId !== workspaceId || record.version !== 1 || record.transcriptDigest !== state.transcript ||
      record.sourceCount !== state.sourceIds.size || record.objectCount !== state.objectIds.size ||
      record.encryptedBytes !== state.encryptedBytes || (record.evidencePartCount ?? 0) !== evidenceCount(state.evidenceStates)) {
    throw new Error("History recovery final manifest mismatch")
  }
  state.completed = true
}
async function validateReaderArchiveRecord(record: Exclude<HistoryRecoveryRecord, HistoryRecoveryManifest>, workspaceId: string,
  state: ReaderState): Promise<void> {
  state.transcript = await transcriptNext(state.transcript, record)
  if (record.kind === "archive-source") return validateReaderSource(record, workspaceId, state)
  if (record.kind === "encrypted-object") return validateReaderObject(record, state)
  if (record.kind === "local-evidence-part") {
    validateEvidencePart(record, state.evidenceStates)
    if (++state.evidencePartTotal > 1_048_576) throw new Error("Too many local history recovery evidence parts")
    return
  }
  throw new Error("Unknown history recovery record")
}
function validateReaderSource(record: Extract<HistoryRecoveryRecord, { kind: "archive-source" }>, workspaceId: string, state: ReaderState): void {
  if (record.workspaceId !== workspaceId || state.sourceIds.has(record.id) || !record.id || !Number.isSafeInteger(record.keyEpoch) ||
      record.keyEpoch < 1 || record.roots.length < 1 || record.roots.length > 4 || !/^[A-Za-z0-9_-]{1,128}$/.test(record.scopeId) ||
      encoder.encode(record.signedJson).length > Math.ceil(256 * 1024 * 4 / 3) ||
      encoder.encode(canonical(record.authorityEvidence)).length > 2 * 1024 * 1024) throw new Error("Invalid history recovery source")
  validateEncodedBytes(record.key, 32)
  validateBoundedBytes(record.signedJson, 256 * 1024)
  state.sourceIds.add(record.id)
  if (state.sourceIds.size > 256) throw new Error("Too many history recovery sources")
  const epochs = state.sourceEpochs.get(record.scopeId) ?? new Set<number>()
  epochs.add(record.keyEpoch)
  state.sourceEpochs.set(record.scopeId, epochs)
}
async function validateReaderObject(record: Extract<HistoryRecoveryRecord, { kind: "encrypted-object" }>, state: ReaderState): Promise<void> {
  const identity = `${record.scopeId}/${record.ciphertextId}`
  if (state.objectIds.has(identity) || !state.sourceEpochs.get(record.scopeId)?.has(record.object.keyEpoch)) {
    throw new Error("Duplicate or unbound history recovery object")
  }
  const object = captureEncryptedArchiveObject(record.object, record.scopeId), encoded = encoder.encode(canonical(object))
  if (await digest(encoded) !== record.ciphertextId) throw new Error("History recovery ciphertext hash mismatch")
  state.encryptedBytes += encoded.length
  if (state.encryptedBytes > TOTAL_LIMIT || state.objectIds.size >= 1_048_576) throw new Error("History recovery encrypted object limit exceeded")
  state.objectIds.add(identity)
}
async function deriveKey(seed: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const copiedSeed = new Uint8Array(seed)
  try {
    if (copiedSeed.length !== 32) throw new Error("Invalid history recovery root seed")
    const source = await crypto.subtle.importKey("raw", copiedSeed, "HKDF", false, ["deriveBits"])
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(salt), info: new Uint8Array(SEED_INFO) },
      source, 256))
  } finally { copiedSeed.fill(0) }
}
function archiveScope(key: Uint8Array, headerHash: string): ArchiveEncryptionScope {
  return { scopeId: `recovery-${headerHash}`, keyEpoch: 1, key }
}
function binding(workspaceId: string, headerHash: string, recordIndex: number, objectId: string,
  partIndex: number, partCount: number) {
  return { workspaceId, historyEpoch: 1, indexId: `recovery/${headerHash}/${recordIndex}`, objectId,
    objectKind: "part" as const, partIndex, partCount }
}
function parseHeader(value: unknown): HistoryRecoveryFileHeader {
  exact(value, ["kind", "version", "workspaceId", "identityRecovery", "salt"])
  if (value.kind !== "tincanban-history-recovery" || value.version !== 1) throw new Error("Unsupported history recovery file")
  text(value.workspaceId, 256)
  const identityRecovery = value.identityRecovery as IdentityDeviceRecoveryFile
  const checked = parseIdentityRecoveryFile(canonical(identityRecovery))
  if (!("kind" in checked) || checked.kind !== "tincanban-identity-device-recovery") throw new Error("A full device recovery package is required")
  bytes(String(value.salt), 32)
  return { kind: value.kind, version: 1, workspaceId: value.workspaceId, identityRecovery: checked, salt: String(value.salt) }
}

/** Stream canonical archive records into independently authenticated encrypted fragments. */
export async function createHistoryRecoveryFileWriter(input: {
  workspaceId: string; identityRecovery: IdentityDeviceRecoveryFile; seed: Uint8Array
}): Promise<{ write(record: HistoryRecoveryRecord): Promise<void>; finish(): Promise<Blob> }> {
  const workspaceId = input.workspaceId
  text(workspaceId, 256)
  const identityRecovery = parseIdentityRecoveryFile(canonical(input.identityRecovery))
  if (!("kind" in identityRecovery) || identityRecovery.kind !== "tincanban-identity-device-recovery") {
    throw new Error("A full device recovery package is required")
  }
  const seed = new Uint8Array(input.seed)
  let keyBytes: Uint8Array | undefined
  let terminal = false
  try {
    const derived = await profileFromIdentitySeedForDevice(seed)
    if (derived.identity.personId !== identityRecovery.personId) throw new Error("History recovery root identity mismatch")
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const header: HistoryRecoveryFileHeader = { kind: "tincanban-history-recovery", version: 1, workspaceId,
      identityRecovery, salt: toBase64Url(salt) }
    const headerHash = await digest(encoder.encode(canonical(header)))
    keyBytes = await deriveKey(seed, salt)
    const scope = archiveScope(keyBytes, headerHash)
    const headerLine = encoder.encode(canonical(header) + "\n")
    const output: BlobPart[] = [headerLine]
    let outputBytes = headerLine.byteLength
    const state: WriterState = { recordIndex: 0, totalBytes: 0, previous: await digest(encoder.encode(TRANSCRIPT_START)),
      manifestSeen: false, encryptedBytes: 0, evidencePartTotal: 0, sourceIds: new Set(), objectIds: new Set(),
      sourceEpochs: new Map(), evidenceStates: new Map() }
    const ensureOpen = () => { if (terminal || state.manifestSeen) throw new Error("History recovery file is already complete") }
    return {
      async write(inputRecord) {
        ensureOpen()
        const record = structuredClone(inputRecord)
        recordShape(record)
        const recordBytes = encoder.encode(canonical(record))
        if (recordBytes.length > RECORD_LIMIT) throw new Error("History recovery record exceeds size limit")
        if (state.totalBytes + recordBytes.length > TOTAL_LIMIT) throw new Error("History recovery file exceeds size limit")
        await validateWriterRecord(record, workspaceId, state)
        state.totalBytes += recordBytes.length
        outputBytes = await appendRecordFragments(recordBytes, state, scope, workspaceId, headerHash, output, outputBytes)
        recordBytes.fill(0)
        state.recordIndex++
      },
      async finish() {
        if (terminal) throw new Error("History recovery file already finished")
        if (!state.manifestSeen) throw new Error("History recovery final manifest is required before completion")
        terminal = true
        scope.key.fill(0)
        return new Blob(output, { type: "application/x-tincanban-history-recovery+jsonl" })
      },
    }
  } catch (error) { keyBytes?.fill(0); throw error }
  finally { seed.fill(0) }
}

async function* lines(blob: Blob): AsyncGenerator<JsonLine> {
  const reader = blob.stream().getReader(), decoder = new TextDecoder("utf-8", { fatal: true })
  let pending = "", pendingBytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      pending += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline)
        const consumed = encoder.encode(line + "\n").length
        if (!line || line.includes("\r") || consumed > RECORD_LIMIT + 256 * 1024) throw new Error("Invalid or oversized history recovery row")
        yield { text: line, bytes: consumed }
        pending = pending.slice(newline + 1)
        pendingBytes = encoder.encode(pending).length
      }
      pendingBytes = encoder.encode(pending).length
      if (pendingBytes > RECORD_LIMIT + 256 * 1024) throw new Error("History recovery row exceeds size limit")
    }
    pending += decoder.decode()
    if (pending.length || pendingBytes) throw new Error("Truncated history recovery file")
  } finally { reader.releaseLock() }
}

type FragmentProgress = { index: number; part: number; count: number; bytes: number; totalBytes: number; parts: Uint8Array[] }

function parseFragment(value: unknown, progress: FragmentProgress): FragmentRow {
  exact(value, ["kind", "recordIndex", "partIndex", "partCount", "objectId", "ciphertextId", "object"])
  if (value.kind !== "fragment" || value.recordIndex !== progress.index || typeof value.partIndex !== "number" ||
      !Number.isSafeInteger(value.partIndex) || typeof value.partCount !== "number" || !Number.isSafeInteger(value.partCount) ||
      value.partCount < 1 || value.partCount > Math.ceil(RECORD_LIMIT / PART_LIMIT) || value.partIndex !== progress.part ||
      typeof value.objectId !== "string" || typeof value.ciphertextId !== "string") throw new Error("Invalid or out-of-order history recovery fragment")
  if (progress.part === 0) progress.count = value.partCount
  if (value.partCount !== progress.count) throw new Error("Inconsistent history recovery fragment count")
  return value as FragmentRow
}

async function decryptFragment(row: FragmentRow, progress: FragmentProgress, scope: ArchiveEncryptionScope,
  header: HistoryRecoveryFileHeader, headerHash: string): Promise<Uint8Array> {
  const object = captureEncryptedArchiveObject(row.object, scope.scopeId)
  if (object.keyEpoch !== 1) throw new Error("Unsupported history recovery fragment epoch")
  const plain = await openArchiveObject(scope, binding(header.workspaceId, headerHash, progress.index,
    row.objectId, progress.part, progress.count), row.ciphertextId, object)
  if (plain.length > PART_LIMIT || (progress.part + 1 < progress.count && plain.length !== PART_LIMIT)) {
    plain.fill(0)
    throw new Error("Invalid history recovery fragment size")
  }
  return plain
}

function joinFragments(progress: FragmentProgress): Uint8Array {
  if (progress.bytes > RECORD_LIMIT) throw new Error("History recovery record exceeds size limit")
  const joined = new Uint8Array(progress.bytes)
  let offset = 0
  for (const part of progress.parts) { joined.set(part, offset); offset += part.length; part.fill(0) }
  progress.parts = []
  progress.bytes = 0
  progress.part = 0
  progress.index++
  return joined
}

async function readFragments(iterator: AsyncIterator<JsonLine>, progress: FragmentProgress, state: ReaderState,
  scope: ArchiveEncryptionScope, header: HistoryRecoveryFileHeader, headerHash: string,
  records: HistoryRecoveryRecord[]): Promise<void> {
  while (true) {
    const next = await iterator.next()
    if (next.done) return
    progress.totalBytes += next.value.bytes
    if (progress.totalBytes > FILE_LIMIT) throw new Error("History recovery file exceeds size limit")
    if (state.completed) throw new Error("Trailing rows after final history recovery manifest")
    const input: unknown = JSON.parse(next.value.text)
    if (canonical(input) !== next.value.text) throw new Error("Non-canonical history recovery fragment")
    const row = parseFragment(input, progress)
    const plain = await decryptFragment(row, progress, scope, header, headerHash)
    progress.parts.push(plain)
    progress.bytes += plain.length
    progress.part++
    if (progress.part === progress.count) {
      const joined = joinFragments(progress)
      try { await acceptOpenedRecord(joined, header.workspaceId, records, state) } finally { joined.fill(0) }
    }
  }
}

/** Open and authenticate a private history file completely before returning any recovered records. */
export async function openHistoryRecoveryFile(blob: Blob, words: string): Promise<{
  header: HistoryRecoveryFileHeader; transfer: Awaited<ReturnType<typeof openIdentityDeviceRecovery>>["transfer"]
  records: HistoryRecoveryRecord[]
}> {
  if (!(blob instanceof Blob) || blob.size > FILE_LIMIT) throw new Error("History recovery file exceeds size limit")
  const iterator = lines(blob)[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) throw new Error("Empty history recovery file")
  const parsedHeader: unknown = JSON.parse(first.value.text)
  const header = parseHeader(parsedHeader)
  if (canonical(header) !== first.value.text) throw new Error("Non-canonical history recovery header")
  const headerHash = await digest(encoder.encode(canonical(header))), salt = bytes(header.salt, 32)
  const identity = await openIdentityDeviceRecovery(header.identityRecovery, words)
  const recovered = await openIdentityRecoveryEnvelope(header.identityRecovery.recovery as IdentityRecoveryEnvelope, words)
  const seed = await identitySeedFromPrivateKey(recovered.privateKeys.identityPrivateKey!, header.identityRecovery.personId)
  let keyBytes: Uint8Array
  try {
    if (identity.transfer.personalRoot.identity.personId !== header.identityRecovery.personId) throw new Error("History recovery identity mismatch")
    keyBytes = await deriveKey(seed, salt)
  } finally { seed.fill(0) }
  const scope = archiveScope(keyBytes, headerHash)
  const records: HistoryRecoveryRecord[] = []
  const progress: FragmentProgress = { index: 0, part: 0, count: 0, totalBytes: first.value.bytes, parts: [], bytes: 0 }
  const state: ReaderState = { transcript: await digest(encoder.encode(TRANSCRIPT_START)), encryptedBytes: 0,
    recoveredRecordBytes: 0, evidencePartTotal: 0, sourceIds: new Set(), objectIds: new Set(),
    sourceEpochs: new Map(), evidenceStates: new Map(), completed: false }
  try {
    await readFragments(iterator, progress, state, scope, header, headerHash, records)
    if (!state.completed || progress.part !== 0 || records.at(-1)?.kind !== "history-recovery-manifest") throw new Error("History recovery file is incomplete; final manifest missing")
    return { header, transfer: identity.transfer, records }
  } finally {
    for (const fragment of progress.parts) fragment.fill(0)
    keyBytes.fill(0)
    scope.key.fill(0)
  }
}
