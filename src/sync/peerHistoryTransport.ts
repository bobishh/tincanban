import type { DuplexStream, SyncConnection } from "./transport"
import { MeshNetworkError } from "@meta-uber/mesh-transport"
import { PeerHistoryObjectUnavailableError } from "./peerHistoryErrors"
export { PeerHistoryObjectUnavailableError } from "./peerHistoryErrors"
import { captureArchiveTreeContext, type ArchiveObjectReadBinding } from "@meta-uber/mesh-replication/history-archive"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const MAGIC = encoder.encode("tincanban-peer-history-v1\n")
const MAX_REQUEST_BYTES = 4 * 1024
const MAX_PAGE_BYTES = 64 * 1024
const MAX_PART_BYTES = 256 * 1024
const MAX_HISTORY_DOCUMENT_BYTES = 256 * 1024 * 1024
const PEER_HISTORY_DEADLINE_MS = 10_000
const PEER_HISTORY_DOCUMENT_DEADLINE_MS = 60_000
const MAX_OBJECT_ID = /^[A-Za-z0-9_-]{43}$/

export function readPeerHistoryRequestOrPairing(stream: DuplexStream): Promise<Uint8Array> {
  if (!stream.readPairingOrRawPrefix) throw new Error("Bounded pairing/raw ingress is unavailable")
  return stream.readPairingOrRawPrefix(MAGIC, MAX_REQUEST_BYTES)
}

/** The join acknowledgement channel also carries bounded peer-history requests. */
export function readPeerHistoryAwareAcceptStream(connection: SyncConnection): SyncConnection {
  return {
    ...connection,
    acceptStream: async () => {
      const stream = await connection.acceptStream()
      return { ...stream, read: () => readPeerHistoryRequestOrPairing(stream) }
    },
  }
}

async function readRaw(stream: DuplexStream, maximumBytes: number): Promise<Uint8Array> {
  if (!stream.readRaw) throw new Error("Raw bounded stream reads are unavailable")
  const response = await stream.readRaw(maximumBytes)
  if (!response.byteLength) throw new MeshNetworkError("Peer history stream closed without a response")
  return response
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function hasKeys(value: Record<string, unknown>, count: number): boolean { return Object.keys(value).length === count }
function isBoundedText(value: unknown, maximum: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= maximum }
function isSafeRange(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}

export type PeerHistoryObjectBinding = ArchiveObjectReadBinding

export type PeerHistoryObjectRead = { version: 1; kind: "workspace-history-object-read"; baselineId: string; objectId: string; binding: PeerHistoryObjectBinding }
export type PeerHistoryObjectRequest = { baselineId: string; objectId: string; binding: PeerHistoryObjectBinding }
export type PeerHistoryDocumentRequest = { workspaceId: string; baselineId: string; documentDigest: string; offset: number; length: number }
export type PeerHistoryBaselineRequest = { workspaceId: string; baselineId?: string }

function maximumFor(binding: PeerHistoryObjectBinding) {
  return binding.objectKind === "part" ? MAX_PART_BYTES : MAX_PAGE_BYTES
}

function captureDocumentRead(value: unknown): PeerHistoryDocumentRequest {
  const request = structuredClone(value)
  if (!isRecord(request) || !hasKeys(request, 7)) throw new Error("Invalid peer history document request")
  if (request.version !== 1 || request.kind !== "workspace-history-document-read" ||
      !isBoundedText(request.workspaceId, 256) || new TextEncoder().encode(request.workspaceId).length > 256 ||
      typeof request.baselineId !== "string" || !MAX_OBJECT_ID.test(request.baselineId) ||
      typeof request.documentDigest !== "string" || !MAX_OBJECT_ID.test(request.documentDigest) ||
      !isSafeRange(request.offset, 0, MAX_HISTORY_DOCUMENT_BYTES) || !isSafeRange(request.length, 1, MAX_PART_BYTES)) {
    throw new Error("Invalid peer history document request")
  }
  return request as unknown as PeerHistoryDocumentRequest
}

function captureBaselineRead(value: unknown): PeerHistoryBaselineRequest {
  const request = structuredClone(value)
  if (!isRecord(request) || (Object.keys(request).length !== 3 && Object.keys(request).length !== 4) ||
      request.version !== 1 || request.kind !== "workspace-history-baseline-read" ||
      !isBoundedText(request.workspaceId, 256) || new TextEncoder().encode(request.workspaceId).length > 256) {
    throw new Error("Invalid peer history baseline request")
  }
  if (Object.hasOwn(request, "baselineId") && (typeof request.baselineId !== "string" || !MAX_OBJECT_ID.test(request.baselineId))) {
    throw new Error("Invalid peer history baseline request")
  }
  return { workspaceId: request.workspaceId, ...(typeof request.baselineId === "string" ? { baselineId: request.baselineId } : {}) }
}

function captureReadRequest(value: unknown): PeerHistoryObjectRead {
  const request = structuredClone(value)
  if (!validReadEnvelope(request)) throw new Error("Invalid peer history object request")
  if (!isRecord(request.binding)) throw new Error("Invalid peer history object binding")
  const binding = request.binding
  const context = captureBindingContext(binding)
  if (!hasKeys(binding, 6) ||
      !["page", "record", "part"].includes(binding.objectKind as string) ||
      !isSafeRange(binding.partIndex, 0, Number.MAX_SAFE_INTEGER) ||
      !isSafeRange(binding.partCount, 1, Number.MAX_SAFE_INTEGER) ||
      (binding.partIndex as number) >= (binding.partCount as number)) throw new Error("Invalid peer history object binding")
  return { version: 1, kind: "workspace-history-object-read", baselineId: request.baselineId as string, objectId: request.objectId as string,
    binding: { ...context, objectKind: binding.objectKind as PeerHistoryObjectBinding["objectKind"],
      partIndex: binding.partIndex as number, partCount: binding.partCount as number } }
}

function captureBindingContext(binding: Record<string, unknown>): Pick<PeerHistoryObjectBinding, "workspaceId" | "historyEpoch" | "indexId"> {
  if (typeof binding.workspaceId !== "string" || typeof binding.historyEpoch !== "number" || typeof binding.indexId !== "string") {
    throw new Error("Invalid peer history object binding")
  }
  try { return captureArchiveTreeContext({ workspaceId: binding.workspaceId, historyEpoch: binding.historyEpoch, indexId: binding.indexId }) }
  catch { throw new Error("Invalid peer history object binding") }
}

function validReadEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && hasKeys(value, 5) && value.version === 1 && value.kind === "workspace-history-object-read" &&
    typeof value.objectId === "string" && MAX_OBJECT_ID.test(value.objectId) && typeof value.baselineId === "string" &&
    MAX_OBJECT_ID.test(value.baselineId) && isRecord(value.binding)
}

async function runBoundedPeerHistoryStream<T>(openStream: () => Promise<DuplexStream>, ensureCurrent: () => void | Promise<void>,
  run: (stream: DuplexStream, ensureActive: () => void) => Promise<T>, deadlineAt = Date.now() + PEER_HISTORY_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stream: DuplexStream | undefined
  let expired = false
  const ensureActive = () => {
    if (expired || Date.now() >= deadlineAt) throw new PeerHistoryObjectUnavailableError("Peer history stream deadline exceeded")
  }
  const operation = (async () => {
    const opened = await openStream()
    stream = opened
    if (expired) { void opened.reset?.().catch(() => undefined); ensureActive() }
    await ensureCurrent(); ensureActive()
    return run(opened, ensureActive)
  })()
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new PeerHistoryObjectUnavailableError("Peer history stream deadline exceeded")) },
      Math.max(0, deadlineAt - Date.now()))
  })
  try { return await Promise.race([operation, deadline]) }
  finally {
    if (timer !== undefined) clearTimeout(timer)
    if (stream?.reset) void Promise.resolve(stream.reset()).catch(() => undefined)
  }
}

/** Routing discriminator only; request parsers and live authority guards still validate the frame. */
export function isPeerHistoryFrame(bytes: Uint8Array): boolean { return startsWithMagic(bytes) }

function startsWithMagic(bytes: Uint8Array) {
  return bytes.length >= MAGIC.length && MAGIC.every((byte, index) => bytes[index] === byte)
}

function concatenate(...parts: Uint8Array[]) {
  const size = parts.reduce((total, part) => total + part.length, 0)
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return bytes
}

/** Create one bounded request on a stream belonging to the already authenticated peer connection. */
export async function readPeerHistoryObject(openStream: () => Promise<DuplexStream>, input: PeerHistoryObjectRequest,
  ensureCurrent: () => void | Promise<void>): Promise<Uint8Array> {
  const request = captureReadRequest({ version: 1, kind: "workspace-history-object-read", baselineId: input.baselineId,
    objectId: input.objectId, binding: input.binding })
  const payload = encoder.encode(JSON.stringify(request))
  if (payload.length > MAX_REQUEST_BYTES) throw new Error("Peer history request exceeds its size limit")
  const deadlineAt = Date.now() + PEER_HISTORY_DEADLINE_MS
  await ensureCurrent()
  return runBoundedPeerHistoryStream(openStream, ensureCurrent, async (stream, ensureActive) => {
    await ensureCurrent()
    ensureActive()
    await stream.send(concatenate(MAGIC, payload))
    await stream.closeSend()
    await ensureCurrent()
    ensureActive()
    const response = await readRaw(stream, MAGIC.length + 1 + maximumFor(request.binding))
    await ensureCurrent()
    ensureActive()
    if (!startsWithMagic(response) || response.length <= MAGIC.length) throw new Error("Invalid peer history response")
    const status = response[MAGIC.length]
    const bytes = response.slice(MAGIC.length + 1)
    if (status === 1) {
      if (bytes.length) throw new Error("Invalid unavailable peer history response")
      throw new PeerHistoryObjectUnavailableError()
    }
    if (status !== 0 || bytes.length > maximumFor(request.binding)) throw new Error("Peer history response exceeds its size limit")
    return bytes
  }, deadlineAt)
}

export async function readPeerHistoryBaseline(openStream: () => Promise<DuplexStream>, workspaceId: string,
  ensureCurrent: () => void | Promise<void>, baselineId?: string): Promise<unknown | undefined> {
  const request = captureBaselineRead({ version: 1, kind: "workspace-history-baseline-read", workspaceId, ...(baselineId ? { baselineId } : {}) })
  const payload = encoder.encode(JSON.stringify({ version: 1, kind: "workspace-history-baseline-read", ...request }))
  const maximumResponseBytes = 512 * 1024
  await ensureCurrent()
  return runBoundedPeerHistoryStream(openStream, ensureCurrent, async (stream, ensureActive) => {
    await ensureCurrent(); ensureActive()
    await stream.send(concatenate(MAGIC, payload)); await stream.closeSend(); await ensureCurrent(); ensureActive()
    const response = await readRaw(stream, MAGIC.length + maximumResponseBytes); await ensureCurrent(); ensureActive()
    if (!startsWithMagic(response) || response.length <= MAGIC.length || response.length > MAGIC.length + maximumResponseBytes) {
      throw new Error("Invalid peer history baseline response")
    }
    let value: unknown
    try { value = JSON.parse(decoder.decode(response.subarray(MAGIC.length))) } catch { throw new Error("Invalid peer history baseline response") }
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3 ||
        (value as Record<string, unknown>).version !== 1 || (value as Record<string, unknown>).kind !== "workspace-history-baseline-response" ||
        !Object.hasOwn(value, "descriptor")) throw new Error("Invalid peer history baseline response")
    return (value as { descriptor: unknown | null }).descriptor ?? undefined
  })
}

/** Return undefined for ordinary authenticated live-session frames. */
export function parsePeerHistoryObjectRead(frame: Uint8Array): PeerHistoryObjectRead | undefined {
  if (!startsWithMagic(frame)) return undefined
  if (frame.length > MAGIC.length + MAX_REQUEST_BYTES) throw new Error("Peer history request exceeds its size limit")
  try { return captureReadRequest(JSON.parse(decoder.decode(frame.subarray(MAGIC.length)))) }
  catch { throw new Error("Invalid peer history request") }
}

export function parsePeerHistoryDocumentRead(frame: Uint8Array): PeerHistoryDocumentRequest | undefined {
  if (!startsWithMagic(frame)) return undefined
  if (frame.length > MAGIC.length + MAX_REQUEST_BYTES) throw new Error("Peer history request exceeds its size limit")
  try {
    const value = JSON.parse(decoder.decode(frame.subarray(MAGIC.length))) as Record<string, unknown>
    if (value.kind !== "workspace-history-document-read") return undefined
    return captureDocumentRead(value)
  } catch { throw new Error("Invalid peer history document request") }
}

export function parsePeerHistoryBaselineRead(frame: Uint8Array): PeerHistoryBaselineRequest | undefined {
  if (!startsWithMagic(frame)) return undefined
  if (frame.length > MAGIC.length + MAX_REQUEST_BYTES) throw new Error("Peer history request exceeds its size limit")
  try {
    const value = JSON.parse(decoder.decode(frame.subarray(MAGIC.length))) as Record<string, unknown>
    if (value.kind !== "workspace-history-baseline-read") return undefined
    return captureBaselineRead(value)
  } catch { throw new Error("Invalid peer history baseline request") }
}

export async function readPeerHistoryDocument(openStream: () => Promise<DuplexStream>, input: Omit<PeerHistoryDocumentRequest, "offset"> & { length: number },
  ensureCurrent: () => void | Promise<void>): Promise<Uint8Array> {
  if (!Number.isSafeInteger(input.length) || input.length < 1 || input.length > MAX_HISTORY_DOCUMENT_BYTES) throw new Error("Invalid peer history document length")
  const chunks: Uint8Array[] = []
  const deadlineAt = Date.now() + PEER_HISTORY_DOCUMENT_DEADLINE_MS
  for (let offset = 0; offset < input.length; offset += MAX_PART_BYTES) {
    const request = captureDocumentRead({ version: 1, kind: "workspace-history-document-read", ...input,
      offset, length: Math.min(MAX_PART_BYTES, input.length - offset) })
    const payload = encoder.encode(JSON.stringify({ version: 1, kind: "workspace-history-document-read", ...request }))
    await ensureCurrent()
    const part = await runBoundedPeerHistoryStream(openStream, ensureCurrent, async (stream, ensureActive) => {
      await ensureCurrent()
      ensureActive()
      await stream.send(concatenate(MAGIC, payload)); await stream.closeSend(); await ensureCurrent()
      ensureActive()
      const response = await readRaw(stream, MAGIC.length + 1 + request.length); await ensureCurrent(); ensureActive()
      if (startsWithMagic(response) && response.length === MAGIC.length + 1 && response[MAGIC.length] === 1) {
        throw new PeerHistoryObjectUnavailableError("Peer history document part is unavailable")
      }
      if (!startsWithMagic(response) || response.length <= MAGIC.length || response[MAGIC.length] !== 0) throw new Error("Invalid peer history document response")
      const bytes = response.slice(MAGIC.length + 1)
      if (bytes.length !== request.length) throw new Error("Peer history document part is truncated")
      return bytes
    }, deadlineAt)
    chunks.push(part)
  }
  const document = concatenate(...chunks)
  if (document.length !== input.length || await (await import("../domain/identity")).sha256Base64Url(document) !== input.documentDigest) {
    throw new Error("Peer history document digest changed")
  }
  await ensureCurrent()
  return document
}

/** Serve only one address-bound object; callers recheck live peer/workspace permission in read. */
export async function respondToPeerHistoryObjectRead(stream: DuplexStream, requestValue: PeerHistoryObjectRead,
  read: (baselineId: string, objectId: string, binding: PeerHistoryObjectBinding) => Promise<Uint8Array | undefined>, ensureCurrent: () => void | Promise<void>): Promise<void> {
  const request = captureReadRequest(requestValue)
  let status = 0
  let bytes = new Uint8Array()
  await ensureCurrent()
  try {
    const value = await readWithPeerHistoryDeadline(() => read(request.baselineId, request.objectId, structuredClone(request.binding)))
    await ensureCurrent()
    if (!(value instanceof Uint8Array) || value.length > maximumFor(request.binding)) throw new Error("Invalid history object size")
    bytes = value.slice()
  } catch {
    await ensureCurrent()
    status = 1
  }
  await ensureCurrent()
  await stream.send(concatenate(MAGIC, new Uint8Array([status]), bytes))
  await stream.closeSend()
}

export async function respondToPeerHistoryDocumentRead(stream: DuplexStream, request: PeerHistoryDocumentRequest,
  read: (request: PeerHistoryDocumentRequest) => Promise<Uint8Array | undefined>, ensureCurrent: () => void | Promise<void>): Promise<void> {
  await ensureCurrent()
  let bytes = new Uint8Array(), status = 0
  try {
    const value = await readWithPeerHistoryDeadline(() => read(structuredClone(request))); await ensureCurrent()
    if (!(value instanceof Uint8Array) || value.length !== request.length) throw new Error("Invalid history document part")
    bytes = value.slice()
  } catch { await ensureCurrent(); status = 1 }
  await ensureCurrent()
  await stream.send(concatenate(MAGIC, new Uint8Array([status]), bytes)); await stream.closeSend()
}

export async function respondToPeerHistoryBaselineRead(stream: DuplexStream, requestValue: PeerHistoryBaselineRequest,
  read: (workspaceId: string, baselineId?: string) => Promise<unknown | undefined>, ensureCurrent: () => void | Promise<void>): Promise<void> {
  const request = captureBaselineRead({ version: 1, kind: "workspace-history-baseline-read", ...requestValue })
  await ensureCurrent()
  const descriptor = await readWithPeerHistoryDeadline(() => read(request.workspaceId, request.baselineId))
  await ensureCurrent()
  const response = encoder.encode(JSON.stringify({ version: 1, kind: "workspace-history-baseline-response", descriptor: descriptor ?? null }))
  if (response.length > 512 * 1024) throw new Error("Peer history baseline descriptor exceeds its size limit")
  await stream.send(concatenate(MAGIC, response))
  await stream.closeSend()
}

function readWithPeerHistoryDeadline<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PeerHistoryObjectUnavailableError("Peer history source timed out")), PEER_HISTORY_DEADLINE_MS)
  })
  return Promise.race([Promise.resolve().then(read), deadline]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}
