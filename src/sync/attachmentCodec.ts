import {
  BLOB_CHUNK_BYTES,
  MAX_BLOB_BYTES,
  validateBlobDescriptor,
  verifyBlobBytes,
  type BlobDescriptor,
} from "@meta-uber/mesh-blob"
import { blindObjectId } from "./blindClient"
import {
  decodeBlindBytes,
  decryptPurposeBoundObject,
  encryptPurposeBoundObject,
  type BlindObject,
} from "./blindEnvelope"
import { openWithReplicaContentKeys, parseReplicaContentKeys, type ReplicaContentKeys } from "./replicaContentKeys"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const maxManifestBytes = 64 * 1024
const maxTransferIdLength = 128
const transferIdPattern = /^[A-Za-z0-9_-]{1,128}$/
const objectIdPattern = /^[A-Za-z0-9_-]{43}$/
const descriptorKeys = new Set(["kind", "version", "blobId", "name", "mediaType", "size", "hash", "ticket"])

export type AttachmentScope = { workspaceId: string; scopeId: string } & ReplicaContentKeys
export type AttachmentLocator = { version: 1; blobId: string; transferId: string; manifestId: string }
export type AttachmentManifest = {
  kind: "rusty-attachment-manifest"
  version: 1
  workspaceId: string
  transferId: string
  descriptor: BlobDescriptor
  chunks: Array<{ objectId: string; index: number; bytes: number }>
}
export type SealedAttachment = { locator: AttachmentLocator; manifest: BlindObject; chunks: BlindObject[] }

/** Seal a verified source blob into independently bound Rusty manifest and chunk objects. */
export async function sealAttachment(
  scopeInput: AttachmentScope,
  descriptorInput: BlobDescriptor,
  bytesInput: Uint8Array,
  transferIdInput: string = crypto.randomUUID(),
): Promise<SealedAttachment> {
  const scope = captureScope(scopeInput)
  const descriptor = captureDescriptor(descriptorInput, true)
  const bytes = new Uint8Array(bytesInput)
  const transferId = validateTransferId(transferIdInput)
  const codec = new AttachmentPreparationCodec(scope, manifestDescriptor(descriptor), transferId)
  await verifyBlobBytes(descriptor, bytes)
  const chunks: BlindObject[] = []
  const entries: AttachmentManifest["chunks"] = []
  for (let index = 0; index < codec.chunkCount; index += 1) {
    const part = bytes.slice(index * BLOB_CHUNK_BYTES, (index + 1) * BLOB_CHUNK_BYTES)
    const object = await codec.sealChunk(index, part)
    chunks.push(object)
    entries.push({ objectId: await blindObjectId(object), index, bytes: part.byteLength })
  }
  return { ...await codec.sealManifest(entries), chunks }
}

/** Preserve the v1 wire binding while preparing one bounded chunk at a time. */
export class AttachmentPreparationCodec {
  private readonly scope: AttachmentScope
  private readonly descriptor: BlobDescriptor
  private readonly transferId: string
  private readonly key: Uint8Array
  readonly chunkCount: number
  constructor(scope: AttachmentScope, descriptor: BlobDescriptor, transferId: string) {
    this.scope = captureScope(scope)
    this.descriptor = captureDescriptor(descriptor, false)
    this.transferId = validateTransferId(transferId)
    validateScope(this.scope)
    this.key = readContentKey(this.scope.contentKey)
    this.chunkCount = Math.ceil(this.descriptor.size / BLOB_CHUNK_BYTES)
  }

  private expectedBytes(index: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.chunkCount) throw new Error("Invalid attachment chunk index")
    return Math.min(BLOB_CHUNK_BYTES, this.descriptor.size - index * BLOB_CHUNK_BYTES)
  }

  async sealChunk(index: number, bytes: Uint8Array): Promise<BlindObject> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== this.expectedBytes(index)) throw new Error("Invalid attachment chunk size")
    return encryptPurposeBoundObject(chunkBinding(this.scope, this.descriptor, this.transferId, index, this.chunkCount), this.key, bytes)
  }

  async openChunk(index: number, objectInput: BlindObject): Promise<Uint8Array> {
    const expected = this.expectedBytes(index)
    const object = captureObject(objectInput)
    if (object.scopeId !== this.scope.scopeId || object.keyEpoch !== this.scope.keyEpoch) throw new Error("Prepared attachment chunk scope changed")
    const bytes = await decryptPurposeBoundObject(object,
      chunkBinding(this.scope, this.descriptor, this.transferId, index, this.chunkCount), this.key)
    if (bytes.byteLength !== expected) throw new Error("Prepared attachment chunk size changed")
    return bytes
  }

  async sealManifest(chunksInput: AttachmentManifest["chunks"]): Promise<{ locator: AttachmentLocator; manifest: BlindObject }> {
    const candidate: AttachmentManifest = { kind: "rusty-attachment-manifest", version: 1,
      workspaceId: this.scope.workspaceId, transferId: this.transferId, descriptor: manifestDescriptor(this.descriptor),
      chunks: structuredClone(chunksInput) }
    const locator: AttachmentLocator = { version: 1, blobId: this.descriptor.blobId, transferId: this.transferId, manifestId: "A".repeat(43) }
    const manifest = validateManifest(candidate, this.scope, this.descriptor, locator)
    const bytes = encoder.encode(JSON.stringify(manifest))
    if (bytes.byteLength > maxManifestBytes) throw new Error("Attachment manifest exceeds its size limit")
    const encrypted = await encryptPurposeBoundObject(manifestBinding(this.scope, this.descriptor, this.transferId), this.key, bytes)
    return { locator: { ...locator, manifestId: await blindObjectId(encrypted) }, manifest: encrypted }
  }
}

/** Decrypt and validate manifest only when its private locator and live descriptor agree. */
export async function openAttachmentManifest(
  scopeInput: AttachmentScope,
  descriptorInput: BlobDescriptor,
  locatorInput: AttachmentLocator,
  objectInput: BlindObject,
): Promise<AttachmentManifest> {
  const scope = captureScope(scopeInput)
  const descriptor = captureDescriptor(descriptorInput, true)
  const locator = captureLocator(locatorInput)
  const object = captureObject(objectInput)
  validateScope(scope)
  validateLocator(locator, descriptor)
  if (object.scopeId !== scope.scopeId || await blindObjectId(object) !== locator.manifestId) {
    throw new Error("Attachment manifest object does not match its scope or locator")
  }
  const plaintext = await openWithReplicaContentKeys(scope, object.keyEpoch, contentKey => decryptPurposeBoundObject(object,
    manifestBinding(scope, descriptor, locator.transferId, object.keyEpoch), readContentKey(contentKey)))
  if (plaintext.byteLength > maxManifestBytes) throw new Error("Attachment manifest exceeds its size limit")
  let parsed: unknown
  try { parsed = JSON.parse(decoder.decode(plaintext)) as unknown }
  catch (cause) { throw new Error("Invalid encrypted attachment manifest", { cause }) }
  const manifest = validateManifest(parsed, scope, descriptor, locator)
  return manifest
}

/** Open one chunk after validating its manifest position, ciphertext ID, and AAD binding. */
export async function openAttachmentChunk(
  scopeInput: AttachmentScope,
  descriptorInput: BlobDescriptor,
  locatorInput: AttachmentLocator,
  manifestInput: AttachmentManifest,
  indexInput: number,
  objectInput: BlindObject,
): Promise<Uint8Array> {
  const scope = captureScope(scopeInput)
  const descriptor = captureDescriptor(descriptorInput, true)
  const locator = captureLocator(locatorInput)
  const manifest = structuredClone(manifestInput)
  const object = captureObject(objectInput)
  const index = indexInput
  validateScope(scope)
  validateLocator(locator, descriptor)
  const validManifest = validateManifest(manifest, scope, descriptor, locator)
  if (!Number.isSafeInteger(index) || index < 0 || index >= validManifest.chunks.length) {
    throw new Error("Attachment chunk index is outside its manifest")
  }
  const entry = validManifest.chunks[index]!
  if (object.scopeId !== scope.scopeId || await blindObjectId(object) !== entry.objectId) {
    throw new Error("Attachment chunk object does not match its manifest")
  }
  const plaintext = await openWithReplicaContentKeys(scope, object.keyEpoch, contentKey => decryptPurposeBoundObject(object,
    chunkBinding(scope, descriptor, locator.transferId, index, validManifest.chunks.length, object.keyEpoch), readContentKey(contentKey)))
  if (plaintext.byteLength !== entry.bytes) throw new Error("Attachment chunk length does not match its manifest")
  return plaintext
}

function captureScope(value: AttachmentScope): AttachmentScope {
  return structuredClone(value)
}

function captureDescriptor(value: BlobDescriptor, allowTicket: boolean): BlobDescriptor {
  const clone = structuredClone(value) as BlobDescriptor
  if (!clone || typeof clone !== "object" || Array.isArray(clone) ||
      !Object.keys(clone).every(key => descriptorKeys.has(key)) ||
      !allowTicket && Object.hasOwn(clone, "ticket")) {
    throw new Error("Invalid attachment descriptor shape")
  }
  if (Object.hasOwn(clone, "ticket") && typeof clone.ticket !== "string") throw new Error("Invalid attachment peer ticket")
  validateBlobDescriptor(clone)
  return { kind: "blob", version: 1, blobId: clone.blobId, name: clone.name, mediaType: clone.mediaType, size: clone.size,
    ...(clone.hash !== undefined ? { hash: clone.hash } : {}),
    ...(allowTicket && clone.ticket !== undefined ? { ticket: clone.ticket } : {}) }
}

function captureLocator(value: AttachmentLocator): AttachmentLocator {
  const clone = structuredClone(value)
  if (!clone || typeof clone !== "object" || Array.isArray(clone) || !hasExactKeys(clone, ["version", "blobId", "transferId", "manifestId"]) ||
      clone.version !== 1 || typeof clone.blobId !== "string" || typeof clone.manifestId !== "string") {
    throw new Error("Invalid attachment locator")
  }
  return { version: 1, blobId: clone.blobId, transferId: validateTransferId(clone.transferId), manifestId: clone.manifestId }
}

function captureObject(value: BlindObject): BlindObject {
  const clone = structuredClone(value)
  if (!clone || typeof clone !== "object" || Array.isArray(clone) || !hasExactKeys(clone, ["version", "scopeId", "keyEpoch", "nonce", "ciphertext"]) ||
      clone.version !== 1 || typeof clone.scopeId !== "string" || !Number.isSafeInteger(clone.keyEpoch) || clone.keyEpoch < 1 ||
      typeof clone.nonce !== "string" || typeof clone.ciphertext !== "string") {
    throw new Error("Invalid encrypted attachment object")
  }
  const nonce = decodeBlindBytes(clone.nonce)
  const ciphertext = decodeBlindBytes(clone.ciphertext)
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 16 || ciphertext.byteLength > BLOB_CHUNK_BYTES + 16) {
    throw new Error("Encrypted attachment object exceeds its size bounds")
  }
  return clone
}

function captureManifestDescriptor(value: unknown): BlobDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid attachment manifest descriptor")
  const candidate = value as BlobDescriptor
  const descriptor = captureDescriptor(candidate, false)
  if (Object.hasOwn(candidate, "ticket")) throw new Error("Attachment manifest cannot contain a peer ticket")
  return descriptor
}

function validateManifest(value: unknown, scope: AttachmentScope, descriptor: BlobDescriptor, locator: AttachmentLocator): AttachmentManifest {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !hasExactKeys(value, ["kind", "version", "workspaceId", "transferId", "descriptor", "chunks"])) {
    throw new Error("Invalid attachment manifest shape")
  }
  const raw = value as Record<string, unknown>
  const storedDescriptor = captureManifestDescriptor(raw.descriptor)
  if (raw.kind !== "rusty-attachment-manifest" || raw.version !== 1 || raw.workspaceId !== scope.workspaceId ||
      raw.transferId !== locator.transferId || locator.blobId !== descriptor.blobId ||
      !sameDescriptor(storedDescriptor, manifestDescriptor(descriptor)) || !Array.isArray(raw.chunks)) {
    throw new Error("Attachment manifest does not match its scope, transfer, or descriptor")
  }
  const expectedCount = Math.ceil(descriptor.size / BLOB_CHUNK_BYTES)
  if (raw.chunks.length !== expectedCount || raw.chunks.length < 1 || raw.chunks.length > MAX_BLOB_BYTES / BLOB_CHUNK_BYTES) {
    throw new Error("Attachment manifest has an invalid chunk count")
  }
  const rawChunks: unknown[] = raw.chunks
  const chunks = rawChunks.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate) ||
        !hasExactKeys(candidate, ["objectId", "index", "bytes"])) {
      throw new Error("Invalid attachment chunk entry")
    }
    const entry = candidate as Record<string, unknown>
    const expectedBytes = Math.min(BLOB_CHUNK_BYTES, descriptor.size - index * BLOB_CHUNK_BYTES)
    if (entry.index !== index || typeof entry.objectId !== "string" || !objectIdPattern.test(entry.objectId) ||
        entry.bytes !== expectedBytes) throw new Error("Attachment chunk entry does not match its manifest position")
    return { objectId: entry.objectId, index, bytes: expectedBytes }
  })
  return { kind: "rusty-attachment-manifest", version: 1, workspaceId: scope.workspaceId,
    transferId: locator.transferId, descriptor: storedDescriptor, chunks }
}

function manifestBinding(scope: AttachmentScope, descriptor: BlobDescriptor, transferId: string, keyEpoch = scope.keyEpoch) {
  return { purpose: "attachment" as const,
    subjectId: JSON.stringify([scope.workspaceId, descriptor.blobId, transferId, "manifest"]),
    scopeId: scope.scopeId, keyEpoch }
}

function chunkBinding(scope: AttachmentScope, descriptor: BlobDescriptor, transferId: string, index: number, count: number,
  keyEpoch = scope.keyEpoch) {
  return { purpose: "attachment" as const,
    subjectId: JSON.stringify([scope.workspaceId, descriptor.blobId, transferId, "chunk", index, count]),
    scopeId: scope.scopeId, keyEpoch }
}

function validateScope(scope: AttachmentScope): void {
  if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
      !hasContentKeyScopeKeys(scope) ||
      typeof scope.workspaceId !== "string" || !scope.workspaceId.trim() || scope.workspaceId.length > 256 ||
      typeof scope.scopeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(scope.scopeId) ||
      !Number.isSafeInteger(scope.keyEpoch) || scope.keyEpoch < 1) {
    throw new Error("Invalid attachment scope")
  }
  parseReplicaContentKeys(scope)
}

function readContentKey(value: string): Uint8Array {
  if (typeof value !== "string") throw new Error("Invalid attachment content key")
  const key = decodeBlindBytes(value)
  if (key.byteLength !== 32) throw new Error("Attachment content key must contain 32 bytes")
  return key
}

function validateTransferId(value: unknown): string {
  if (typeof value !== "string" || value.length > maxTransferIdLength || !transferIdPattern.test(value)) {
    throw new Error("Invalid attachment transfer ID")
  }
  return value
}

function validateLocator(locator: AttachmentLocator, descriptor: BlobDescriptor): void {
  if (!objectIdPattern.test(locator.manifestId) || locator.blobId !== descriptor.blobId) {
    throw new Error("Attachment locator does not match the descriptor")
  }
}

function sameDescriptor(left: BlobDescriptor, right: BlobDescriptor): boolean {
  return left.kind === right.kind && left.version === right.version && left.blobId === right.blobId &&
    left.name === right.name && left.mediaType === right.mediaType && left.size === right.size && left.hash === right.hash
}

function manifestDescriptor(descriptor: BlobDescriptor): BlobDescriptor {
  const stored = { ...descriptor }
  delete stored.ticket
  return stored
}

function hasExactKeys(value: object, keys: string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function hasContentKeyScopeKeys(scope: object): boolean {
  const required = ["workspaceId", "scopeId", "keyEpoch", "contentKey"]
  const optional = ["historicalContentKeys", "historicalContentKeyVariants"]
  return required.every(key => Object.hasOwn(scope, key)) && Object.keys(scope).every(key => required.includes(key) || optional.includes(key))
}
