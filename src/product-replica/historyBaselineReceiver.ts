import { WasmStateCore, type WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { canonicalizeJson } from "@meta-uber/mesh-identity"
import { captureArchiveBytesReference, captureArchiveTreeContext, readArchiveBytes, MAX_ARCHIVE_PART_BYTES,
  type ArchiveBytesReference, type ArchiveTreeContext } from "@meta-uber/mesh-replication/history-archive"
import { captureArchiveLocatorRoot, createLocatedArchiveStore, iterateArchiveLocatorEntries, lookupArchiveLocator, type ArchiveLocatorReader,
  type ArchiveLocatorRoot } from "@meta-uber/mesh-replication/history-archive-locators"
import type { ArchiveEncryptionScope, EncryptedArchiveObject } from "@meta-uber/mesh-replication/history-archive-crypto"
import { captureArchiveCoverageChild, type ArchiveCoverageAuthority } from "@meta-uber/mesh-replication/history-archive-coverage"
import { verifyCompleteArchiveCoverage } from "@meta-uber/mesh-replication/history-archive-coverage-set"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"

export type StoredHistoryBaselineEvidence = {
  workspaceId: string
  state: "staged" | "active" | "restored"
  signedJson: Uint8Array
  document: Uint8Array
  wire?: unknown
  encryptedObjects: Array<{ ciphertextId: string; object: unknown }>
  scopeId: string
  keyEpoch: number
  pinnedStorage: Record<string, unknown>
}

const MAX_SIGNED_BASELINE_BYTES = 256 * 1024
const MAX_BASELINE_DOCUMENT_BYTES = 256 * 1024 * 1024
const MAX_CAPTURED_ENCRYPTED_BYTES = 512 * 1024 * 1024
const MAX_CAPTURED_OBJECTS = 8192
const MAX_ENCRYPTED_PART_TEXT = Math.ceil((MAX_ARCHIVE_PART_BYTES + 16) * 4 / 3)
const encoder = new TextEncoder()

type HistoryBaselineRouting = {
  payload: {
    archive: { context: ArchiveTreeContext; root: { objectId: string; height: number; count: number; first: string | null; last: string | null } }
    locatorRoot: ArchiveLocatorRoot
  }
}

export type HistoryBaselineFetchPort = ArchiveLocatorReader

/** Opaque snapshot routing. The compact document remains encrypted in a separate archive tree. */
export type WireHistoryBaseline = {
  version: 1
  signedJson: string
  basis: { context: ArchiveTreeContext; reference: ArchiveBytesReference; locatorRoot: ArchiveLocatorRoot; coverage: unknown }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key)))
}

/** Validate routing before reads; Native still authenticates every reconstructed byte and binding. */
export function parseWireHistoryBaseline(value: unknown): WireHistoryBaseline {
  const captured = structuredClone(value)
  if (!exactRecord(captured, ["version", "signedJson", "basis"]) || captured.version !== 1 ||
      typeof captured.signedJson !== "string" || !captured.signedJson ||
      !exactRecord(captured.basis, ["context", "reference", "locatorRoot", "coverage"])) {
    throw new Error("History baseline snapshot requires an update")
  }
  const basis = captured.basis
  const context = captureArchiveTreeContext(basis.context as ArchiveTreeContext)
  const locatorRoot = captureArchiveLocatorRoot(basis.locatorRoot)
  if (context.indexId !== "basis-document" || locatorRoot.context.workspaceId !== context.workspaceId ||
      locatorRoot.context.historyEpoch !== context.historyEpoch) throw new Error("History baseline basis routing is invalid")
  const reference = captureArchiveBytesReference(basis.reference as ArchiveBytesReference)
  const coverage = captureArchiveCoverageChild(basis.coverage)
  if (coverage.payload.kind !== "blind-archive-coverage-aggregate-receipt") {
    throw new Error("Compact history basis requires a complete Rusty coverage receipt")
  }
  if (reference.partCount > 1_048_576 || reference.byteLength > MAX_BASELINE_DOCUMENT_BYTES) {
    throw new Error("History baseline compact document exceeds its receive bound")
  }
  const signedJson = decodeBlindBytes(captured.signedJson)
  if (signedJson.length > MAX_SIGNED_BASELINE_BYTES) throw new Error("History baseline signature exceeds size limit")
  return { version: 1, signedJson: captured.signedJson,
    basis: { context, reference, locatorRoot, coverage } }
}

/** Resolve encrypted compact-basis chunks, then pass only reconstructed bytes to the Native verifier. */
export async function verifyReceivedWireHistoryBaseline(input: Omit<Parameters<typeof verifyReceivedHistoryBaseline>[0], "signedJson" | "baselineDocument"> & {
  wire: unknown
}): Promise<WasmVerifiedReceivedHistoryBaseline> {
  const wire = parseWireHistoryBaseline(input.wire)
  const scope = structuredClone(input.scope)
  const previous = input.previous
  if (wire.basis.context.workspaceId !== wire.basis.locatorRoot.context.workspaceId ||
      wire.basis.context.historyEpoch !== wire.basis.locatorRoot.context.historyEpoch ||
      wire.basis.context.workspaceId.length > 256) throw new Error("History baseline basis is outside its signed workspace scope")
  const signedJson = decodeBlindBytes(wire.signedJson)
  const basisObjects = new Map<string, EncryptedArchiveObject>()
  let basisBytes = 0
  const basisFetch: HistoryBaselineFetchPort = {
    ensureCurrent: input.fetch.ensureCurrent,
    download: async ciphertextId => {
      input.ensureCurrent()
      await input.fetch.ensureCurrent()
      const object = structuredClone(await input.fetch.download(ciphertextId))
      input.ensureCurrent()
      await input.fetch.ensureCurrent()
      const encodedBytes = encoder.encode(canonicalizeJson(object)).length
      basisBytes += encodedBytes
      if (basisBytes > MAX_CAPTURED_ENCRYPTED_BYTES || basisObjects.size >= MAX_CAPTURED_OBJECTS && !basisObjects.has(ciphertextId)) {
        throw new Error("Compact history basis evidence exceeds its bounded receive limit")
      }
      const previous = basisObjects.get(ciphertextId)
      if (previous && canonicalizeJson(previous) !== canonicalizeJson(object)) throw new Error("Compact basis ciphertext changed during read")
      basisObjects.set(ciphertextId, object)
      return object
    },
  }
  const directoryCiphertexts = new Set<string>()
  const expectedCoverage: Array<{ objectId: string; keyEpoch: number }> = []
  for await (const entry of iterateArchiveLocatorEntries(scope, wire.basis.locatorRoot, basisFetch,
    ciphertextId => { directoryCiphertexts.add(ciphertextId) })) {
    if (expectedCoverage.length + directoryCiphertexts.size >= MAX_CAPTURED_OBJECTS) {
      throw new Error("Compact history basis locator set exceeds its object bound")
    }
    expectedCoverage.push({ objectId: entry.ciphertextId, keyEpoch: scope.keyEpoch })
  }
  for (const ciphertextId of directoryCiphertexts) expectedCoverage.push({ objectId: ciphertextId, keyEpoch: scope.keyEpoch })
  expectedCoverage.sort((left, right) => left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0)
  if (new Set(expectedCoverage.map(entry => entry.objectId)).size !== expectedCoverage.length) {
    throw new Error("Compact history basis locator set contains duplicate ciphertext")
  }
  const basisCoverageRoot = wire.basis.locatorRoot.root.ciphertextId
  await verifyCompleteArchiveCoverage(wire.basis.coverage, input.pinnedStorage, basisCoverageRoot, expectedCoverage)
  input.ensureCurrent()
  await input.fetch.ensureCurrent()
  const parts: Uint8Array[] = []
  let length = 0
  const stream = await readArchiveBytes(wire.basis.context, wire.basis.reference,
    createLocatedArchiveStore(scope, wire.basis.locatorRoot, basisFetch))
  for await (const part of stream) {
    input.ensureCurrent()
    if (part.length > MAX_BASELINE_DOCUMENT_BYTES - length) throw new Error("History baseline compact document exceeds its receive bound")
    parts.push(part)
    length += part.length
  }
  const document = new Uint8Array(length)
  let offset = 0
  for (const part of parts) { document.set(part, offset); offset += part.length }
  input.ensureCurrent()
  await input.fetch.ensureCurrent()
  return verifyReceivedHistoryBaseline({ ...input, previous, signedJson, baselineDocument: document, initialEncryptedObjects: basisObjects })
}

function baselineReadRouting(signedJson: Uint8Array) {
  // These fields choose read paths only. Native repeats strict envelope parsing
  // and authenticates all fetched encrypted objects before returning a candidate.
  let routing: HistoryBaselineRouting
  try { routing = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(signedJson)) as HistoryBaselineRouting }
  catch { throw new Error("Invalid history baseline routing envelope") }
  const payload = routing?.payload
  if (!payload) throw new Error("History baseline lacks bounded archive read roots")
  const archiveContext = payload.archive?.context
  const archiveRoot = payload.archive?.root
  const locatorRoot = payload.locatorRoot
  if (!archiveContext || archiveContext.indexId !== "catalogue" || !archiveContext.workspaceId ||
      !Number.isSafeInteger(archiveContext.historyEpoch) || archiveContext.historyEpoch < 1 ||
      !archiveRoot || !locatorRoot) throw new Error("History baseline lacks bounded archive read roots")

  return { archiveContext, archiveRoot, locatorRoot }
}

function recordedArchiveReader(fetch: HistoryBaselineFetchPort, ensureCurrent: () => void,
  initialEncryptedObjects?: Map<string, EncryptedArchiveObject>) {
  const fetchDownload = fetch.download
  const fetchEnsureCurrent = fetch.ensureCurrent
  let encryptedBytes = 0
  const objects = new Map<string, EncryptedArchiveObject>()
  if (initialEncryptedObjects) {
    for (const [id, object] of initialEncryptedObjects) {
      const detached = structuredClone(object)
      encryptedBytes += encoder.encode(canonicalizeJson(detached)).length
      if (encryptedBytes > MAX_CAPTURED_ENCRYPTED_BYTES || objects.size >= MAX_CAPTURED_OBJECTS) {
        throw new Error("Cold history archive evidence exceeds its bounded receiver limit")
      }
      objects.set(id, detached)
    }
  }
  const recordingReader: ArchiveLocatorReader = {
    ensureCurrent: async () => {
      ensureCurrent()
      await fetchEnsureCurrent.call(fetch)
    },
    download: async ciphertextId => {
      ensureCurrent()
      const object = structuredClone(await fetchDownload.call(fetch, ciphertextId))
      ensureCurrent()
      await fetchEnsureCurrent.call(fetch)
      const encodedBytes = encoder.encode(canonicalizeJson(object)).length
      encryptedBytes += encodedBytes
      if (encryptedBytes > MAX_CAPTURED_ENCRYPTED_BYTES || objects.size >= MAX_CAPTURED_OBJECTS && !objects.has(ciphertextId)) {
        throw new Error("Cold history archive evidence exceeds its bounded receiver limit")
      }
      const old = objects.get(ciphertextId)
      if (old && canonicalizeJson(old) !== canonicalizeJson(object)) throw new Error("Archive ciphertext changed during cold read")
      objects.set(ciphertextId, object)
      return object
    },
  }
  return { objects, recordingReader }
}

/** Fetch only coverage locator paths; the v2 signed owner checkpoint is inline. */
export async function verifyReceivedHistoryBaseline(input: {
  signedJson: Uint8Array
  baselineDocument: Uint8Array
  scope: ArchiveEncryptionScope
  pinnedStorage: ArchiveCoverageAuthority
  previous?: WasmVerifiedReceivedHistoryBaseline | null
  fetch: HistoryBaselineFetchPort
  ensureCurrent: () => void
  trustedScopeAuthority: unknown
  initialEncryptedObjects?: Map<string, EncryptedArchiveObject>
}): Promise<WasmVerifiedReceivedHistoryBaseline> {
  const signedJson = input.signedJson.slice()
  const baselineDocument = input.baselineDocument.slice()
  const scope = structuredClone(input.scope)
  const pinnedStorage = structuredClone(input.pinnedStorage)
  const trustedScopeAuthority = structuredClone(input.trustedScopeAuthority)
  const previous = input.previous ?? null
  const fetch = input.fetch
  const fetchDownload = fetch?.download
  const fetchEnsureCurrent = fetch?.ensureCurrent
  const ensureCurrent = input.ensureCurrent
  if (signedJson.length > MAX_SIGNED_BASELINE_BYTES || baselineDocument.length > MAX_BASELINE_DOCUMENT_BYTES ||
      !(scope.key instanceof Uint8Array) || scope.key.length !== 32 || typeof ensureCurrent !== "function" ||
      typeof fetchDownload !== "function" || typeof fetchEnsureCurrent !== "function") {
    throw new Error("Invalid or oversized history baseline receive input")
  }
  ensureCurrent()

  const { archiveContext, archiveRoot, locatorRoot } = baselineReadRouting(signedJson)

  const { objects, recordingReader } = recordedArchiveReader(fetch, ensureCurrent, input.initialEncryptedObjects)
  const catalogue = { context: archiveContext, root: archiveRoot }

  await lookupArchiveLocator(scope, locatorRoot, {
    ...catalogue.context, objectId: catalogue.root.objectId, objectKind: "page", partIndex: 0, partCount: 1,
  }, recordingReader)
  ensureCurrent()
  await fetchEnsureCurrent.call(fetch)
  return previous ? WasmStateCore.verifyOwnerAttestedHistoryBaselineFromParent(signedJson, baselineDocument, scope.scopeId,
    scope.keyEpoch, scope.key, pinnedStorage, trustedScopeAuthority, previous, objects, ensureCurrent) :
    WasmStateCore.verifyOwnerAttestedHistoryBaseline(signedJson, baselineDocument, scope.scopeId,
      scope.keyEpoch, scope.key, pinnedStorage, trustedScopeAuthority, objects, ensureCurrent)
}

async function reverifyRetainedWire(stored: StoredHistoryBaselineEvidence, scope: ArchiveEncryptionScope,
  objects: Map<string, EncryptedArchiveObject>, ensureCurrent: () => void): Promise<void> {
    if (stored.wire !== undefined) {
      const wire = parseWireHistoryBaseline(stored.wire)
      if (decodeBlindBytes(wire.signedJson).length !== stored.signedJson.length ||
          !decodeBlindBytes(wire.signedJson).every((byte, index) => byte === stored.signedJson[index])) {
        throw new Error("Stored history wire descriptor differs from its signed baseline")
      }
      const basis = new Uint8Array(await collectArchiveBytes(wire, scope, objects, ensureCurrent))
      if (basis.length !== stored.document.length || !basis.every((byte, index) => byte === stored.document[index])) {
        throw new Error("Stored compact basis differs from its encrypted source")
      }
      const offlineBasis: HistoryBaselineFetchPort = {
        ensureCurrent: ensureCurrent,
        download: async ciphertextId => {
          const object = objects.get(ciphertextId)
          if (!object) throw new Error("Stored compact-basis coverage object is missing")
          return object
        },
      }
      const directoryCiphertexts = new Set<string>()
      const expected: Array<{ objectId: string; keyEpoch: number }> = []
      for await (const entry of iterateArchiveLocatorEntries(scope, wire.basis.locatorRoot, offlineBasis,
        ciphertextId => { directoryCiphertexts.add(ciphertextId) })) {
        if (expected.length + directoryCiphertexts.size >= MAX_CAPTURED_OBJECTS) {
          throw new Error("Stored compact-basis coverage set exceeds its object bound")
        }
        expected.push({ objectId: entry.ciphertextId, keyEpoch: scope.keyEpoch })
      }
      for (const ciphertextId of directoryCiphertexts) expected.push({ objectId: ciphertextId, keyEpoch: scope.keyEpoch })
      expected.sort((left, right) => left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0)
      if (new Set(expected.map(entry => entry.objectId)).size !== expected.length) throw new Error("Stored compact-basis coverage set contains duplicate objects")
      await verifyCompleteArchiveCoverage(wire.basis.coverage, stored.pinnedStorage as ArchiveCoverageAuthority,
        wire.basis.locatorRoot.root.ciphertextId, expected)
    }
}

async function reverifyRetainedCiphertexts(stored: StoredHistoryBaselineEvidence, scope: ArchiveEncryptionScope,
  trustedScopeAuthority: unknown, previous: WasmVerifiedReceivedHistoryBaseline | null | undefined, ensureCurrent: () => void): Promise<WasmVerifiedReceivedHistoryBaseline> {
    const objects = new Map<string, EncryptedArchiveObject>()
    for (const entry of stored.encryptedObjects) {
      if (!entry || typeof entry.ciphertextId !== "string" || !entry.ciphertextId || objects.has(entry.ciphertextId)) {
        throw new Error("Stored history ciphertext evidence is malformed")
      }
    objects.set(entry.ciphertextId, entry.object as EncryptedArchiveObject)
    }
    await reverifyRetainedWire(stored, scope, objects, ensureCurrent)
    ensureCurrent()
    return previous ? WasmStateCore.verifyOwnerAttestedHistoryBaselineFromParent(stored.signedJson, stored.document, scope.scopeId,
      scope.keyEpoch, scope.key, stored.pinnedStorage, trustedScopeAuthority, previous, objects, ensureCurrent) :
      WasmStateCore.verifyOwnerAttestedHistoryBaseline(stored.signedJson, stored.document, scope.scopeId,
        scope.keyEpoch, scope.key, stored.pinnedStorage, trustedScopeAuthority, objects, ensureCurrent)
}

/** Recreate the opaque Native handle from a durable stage after reload. Never trust a serialized host-side verification flag. */
export async function reverifyStoredHistoryBaseline(input: {
  stored: StoredHistoryBaselineEvidence
  scope: ArchiveEncryptionScope
  previous?: WasmVerifiedReceivedHistoryBaseline | null
  fetch?: HistoryBaselineFetchPort
  ensureCurrent: () => void
  trustedScopeAuthority: unknown
}): Promise<WasmVerifiedReceivedHistoryBaseline> {
  assertStoredHistoryBounds(input.stored)
  const stored = structuredClone(input.stored)
  const scope = structuredClone(input.scope)
  const trustedScopeAuthority = structuredClone(input.trustedScopeAuthority)
  const previous = input.previous
  assertStoredHistoryScope(stored, scope)
  const candidate = await createStoredCandidate(stored, scope, trustedScopeAuthority, previous, input)
  return verifyStoredCandidate(candidate, stored)
}

function assertStoredHistoryBounds(stored: StoredHistoryBaselineEvidence): void {
  if (!stored || !(stored.signedJson instanceof Uint8Array) || stored.signedJson.length > MAX_SIGNED_BASELINE_BYTES ||
      !(stored.document instanceof Uint8Array) || stored.document.length > MAX_BASELINE_DOCUMENT_BYTES ||
      !Array.isArray(stored.encryptedObjects) || stored.encryptedObjects.length > MAX_CAPTURED_OBJECTS) {
    throw new Error("Stored history baseline exceeds its bounded verification limits")
  }
  assertEncryptedRowsBound(stored.encryptedObjects)
}

function assertEncryptedRowsBound(rows: StoredHistoryBaselineEvidence["encryptedObjects"]): void {
  let totalBytes = 0
  const ids = new Set<string>()
  for (const entry of rows) {
    validateRetainedCiphertextEntry(entry, ids)
    const object = entry.object as { scopeId: string; nonce: string; ciphertext: string }
    totalBytes += object.scopeId.length + object.nonce.length + object.ciphertext.length + 128
    if (totalBytes > MAX_CAPTURED_ENCRYPTED_BYTES) throw new Error("Stored history ciphertext evidence exceeds its byte bound")
  }
}

function validateRetainedCiphertextEntry(entry: StoredHistoryBaselineEvidence["encryptedObjects"][number], ids: Set<string>): void {
  const object: unknown = entry?.object
  if (!entry || typeof entry.ciphertextId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(entry.ciphertextId) || ids.has(entry.ciphertextId) ||
      !object || typeof object !== "object" || Array.isArray(object)) throw new Error("Stored history ciphertext evidence is malformed")
  const value = object as Record<string, unknown>
  if (!exactStoredCiphertext(value)) throw new Error("Stored history ciphertext evidence is malformed")
  ids.add(entry.ciphertextId)
}

function exactStoredCiphertext(value: Record<string, unknown>): boolean {
  const keys = ["version", "scopeId", "keyEpoch", "nonce", "ciphertext"]
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) && value.version === 1 &&
    typeof value.scopeId === "string" && value.scopeId.length <= 128 && Number.isSafeInteger(value.keyEpoch) &&
    typeof value.nonce === "string" && /^[A-Za-z0-9_-]{16}$/.test(value.nonce) && typeof value.ciphertext === "string" &&
    value.ciphertext.length >= 22 && value.ciphertext.length <= MAX_ENCRYPTED_PART_TEXT && /^[A-Za-z0-9_-]+$/.test(value.ciphertext)
}

function assertStoredHistoryScope(stored: StoredHistoryBaselineEvidence, scope: ArchiveEncryptionScope): void {
  if ((stored.state !== "staged" && stored.state !== "active") || !stored.workspaceId || stored.scopeId !== scope.scopeId ||
      stored.keyEpoch !== scope.keyEpoch || !stored.pinnedStorage || typeof stored.pinnedStorage !== "object") {
    throw new Error("Stored history baseline is outside its pinned receive scope")
  }
}

async function createStoredCandidate(stored: StoredHistoryBaselineEvidence, scope: ArchiveEncryptionScope,
  trustedScopeAuthority: unknown, previous: WasmVerifiedReceivedHistoryBaseline | null | undefined,
  input: { fetch?: HistoryBaselineFetchPort; ensureCurrent: () => void }): Promise<WasmVerifiedReceivedHistoryBaseline> {
  if (stored.encryptedObjects.length > 0) {
    return reverifyRetainedCiphertexts(stored, scope, trustedScopeAuthority, previous, input.ensureCurrent)
  }
  if (!input.fetch) throw new Error("Stored history baseline has no offline-verifiable ciphertext evidence")
  return verifyReceivedHistoryBaseline({ signedJson: stored.signedJson, baselineDocument: stored.document,
    scope, pinnedStorage: stored.pinnedStorage as ArchiveCoverageAuthority, trustedScopeAuthority, previous,
    fetch: input.fetch, ensureCurrent: input.ensureCurrent })
}

function verifyStoredCandidate(candidate: WasmVerifiedReceivedHistoryBaseline,
  stored: StoredHistoryBaselineEvidence): WasmVerifiedReceivedHistoryBaseline {
  try {
    const capturedDocument = candidate.document(), capturedSigned = candidate.originalJson()
    if (capturedDocument.length !== stored.document.length || !capturedDocument.every((byte, index) => byte === stored.document[index]) ||
        capturedSigned.length !== stored.signedJson.length || !capturedSigned.every((byte, index) => byte === stored.signedJson[index])) {
      throw new Error("Reverified history baseline differs from its durable source")
    }
    return candidate
  } catch (error) {
    candidate.free()
    throw error
  }
}

async function collectArchiveBytes(wire: WireHistoryBaseline, scope: ArchiveEncryptionScope,
  objects: Map<string, EncryptedArchiveObject>, ensureCurrent: () => void): Promise<Uint8Array> {
  const reader: ArchiveLocatorReader = { ensureCurrent, download: async id => {
    ensureCurrent()
    const object = objects.get(id)
    if (!object) throw new Error("Stored compact basis ciphertext is unavailable offline")
    return structuredClone(object)
  } }
  const stream = await readArchiveBytes(wire.basis.context, wire.basis.reference,
    createLocatedArchiveStore(scope, wire.basis.locatorRoot, reader))
  const parts: Uint8Array[] = []
  let length = 0
  for await (const part of stream) {
    ensureCurrent()
    if (part.length > MAX_BASELINE_DOCUMENT_BYTES - length) throw new Error("Stored compact basis exceeds its bound")
    parts.push(part)
    length += part.length
  }
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
