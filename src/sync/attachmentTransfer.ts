import { BLOB_CHUNK_BYTES, validateBlobDescriptor, type BlobDescriptor } from "@meta-uber/mesh-blob"
import { openAttachmentManifest, openAttachmentChunk,
  type AttachmentScope, type AttachmentManifest } from "./attachmentCodec"
import type { AttachmentLocator } from "../product-replica"
import { createBlobStreamVerifier, type BlobByteSource } from "@meta-uber/mesh-blob/stream"
import type { AttachmentPreparationRepository } from "./attachmentPreparationData"
import { prepareAttachmentStream } from "./attachmentPreparation"
import type { BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { blindHash, blindObjectId, canonicalBlindJson, type BlindAccess } from "./blindClient"
import { uploadBlindBlob, downloadBlindBlob, verifyBlindBlobReceipt, type BlindBlobReceipt } from "./blindBlobClient"
import { parseAttachmentLocators } from "../product-replica/attachmentIndex"

export type AttachmentProgress = {
  version: 1
  generation: number
  binding: string
  descriptor: BlobDescriptor
  locator: AttachmentLocator
  objects: Array<{ objectId: string; requestId: string }>
  receipts: Record<string, BlindBlobReceipt>
  received: string[]
}
export type AttachmentTransferRepository = {
  preparation?: AttachmentPreparationRepository
  read: () => Promise<AttachmentProgress | null>
  object: (id: string) => Promise<BlindObject | null>
  commit: (expected: number | null, next: AttachmentProgress,
    objects?: Array<{ objectId: string; object: BlindObject }>) => Promise<void>
  migrateBinding?: (expected: number, previousBinding: string, next: AttachmentProgress) => Promise<void>
}
export type AttachmentTransport = {
  upload: (access: BlindAccess, object: BlindObject, requestId: string) => Promise<BlindBlobReceipt>
  download: (access: BlindAccess, id: string) => Promise<BlindObject>
}

function validProgressHeader(state: AttachmentProgress, binding: string, descriptor: BlobDescriptor): boolean {
  return state.version === 1 && Number.isSafeInteger(state.generation) && state.generation >= 0 &&
    state.binding === binding && canonicalBlindJson(portableDescriptor(state.descriptor)) === canonicalBlindJson(descriptor) &&
    Array.isArray(state.objects) && state.objects.length >= 2 && state.objects.length <= 33 &&
    Array.isArray(state.received) && state.received.length <= state.objects.length &&
    !!state.receipts && typeof state.receipts === "object" && !Array.isArray(state.receipts)
}

function assertProgressObjects(state: AttachmentProgress, descriptor: BlobDescriptor): void {
  const ids = state.objects.map(item => item.objectId)
  if (new Set(ids).size !== ids.length || ids.some(id => !/^[A-Za-z0-9_-]{43}$/.test(id)) ||
    state.objects.some(item => typeof item.requestId !== "string" || !/^[A-Za-z0-9_-]{20,64}$/.test(item.requestId)) ||
    Object.keys(state.receipts).some(id => !ids.includes(id)) || state.received.some(id => !ids.includes(id)) ||
    new Set(state.received).size !== state.received.length || ids.at(-1) !== state.locator.manifestId ||
    state.locator.blobId !== descriptor.blobId) throw new Error("Invalid attachment object progress")
}

function portableDescriptor(value: BlobDescriptor): BlobDescriptor {
  const descriptor = structuredClone(validateBlobDescriptor(structuredClone(value)))
  delete descriptor.ticket
  return descriptor
}

export class AttachmentTransfer {
  private readonly scope: AttachmentScope
  private readonly access: BlindAccess
  private readonly binding: Promise<string>
  private readonly legacyBinding: Promise<string>
  private validated = new Set<string>()
  constructor(scope: AttachmentScope, access: BlindAccess, private readonly repository: AttachmentTransferRepository,
    private readonly guard: () => Promise<void>, private readonly transport: AttachmentTransport = {
      upload: uploadBlindBlob, download: downloadBlindBlob,
    }) {
    this.scope = structuredClone(scope)
    this.access = structuredClone(access)
    if (scope.scopeId !== access.scopeId) throw new Error("Attachment scope does not match storage access")
    this.binding = blindHash(new TextEncoder().encode(canonicalBlindJson([2, this.scope.workspaceId, this.scope.scopeId,
      this.scope.keyEpoch, this.scope.contentKey, this.access.origin, this.access.servicePublicKey])))
    this.legacyBinding = blindHash(new TextEncoder().encode(canonicalBlindJson([this.scope.workspaceId, this.scope.scopeId,
      this.scope.keyEpoch, this.scope.contentKey, this.access.origin, this.access.servicePublicKey,
      this.access.readToken, this.access.writeToken, this.access.policyRevision])))
  }

  async upload(descriptorInput: BlobDescriptor, bytesInput?: Uint8Array): Promise<AttachmentLocator> {
    const descriptor = portableDescriptor(descriptorInput)
    const bytes = bytesInput === undefined ? undefined : new Uint8Array(bytesInput)
    async function* source() {
      for (let offset = 0; bytes && offset < bytes.length; offset += BLOB_CHUNK_BYTES) {
        yield bytes.slice(offset, offset + BLOB_CHUNK_BYTES)
      }
    }
    return this.uploadStream(descriptor, bytes ? source() : undefined)
  }

  async uploadStream(descriptorInput: BlobDescriptor, source?: BlobByteSource): Promise<AttachmentLocator> {
    const descriptor = portableDescriptor(descriptorInput)
    await this.guard()
    let state = await this.read(descriptor)
    if (!state) state = await prepareAttachmentStream(this.scope, descriptor, await this.binding, this.repository, this.guard, source)
    return this.uploadPrepared(state)
  }

  private async uploadPrepared(initial: AttachmentProgress): Promise<AttachmentLocator> {
    let state = initial
    await this.validatePrepared(state)
    // Chunks precede their manifest. A confirmed locator covers every required object.
    for (const item of state.objects) {
      if (state.receipts[item.objectId]) continue
      await this.guard()
      const object = await this.requireObject(item.objectId)
      const receipt = await this.transport.upload(this.access, object, item.requestId)
      await verifyBlindBlobReceipt(receipt, this.access, object, item.requestId)
      await this.guard()
      const next: AttachmentProgress = { ...state, generation: state.generation + 1,
        receipts: { ...state.receipts, [item.objectId]: receipt } }
      await this.repository.commit(state.generation, next)
      state = next
    }
    await this.guard()
    this.validated.clear()
    this.validated.add(canonicalBlindJson(state))
    return structuredClone(state.locator)
  }

  async download(descriptorInput: BlobDescriptor, locatorInput: AttachmentLocator): Promise<Uint8Array> {
    const descriptor = portableDescriptor(descriptorInput)
    const source = this.downloadStream(descriptor, locatorInput)
    const output = new Uint8Array(descriptor.size)
    let offset = 0
    for await (const chunk of source) { output.set(chunk, offset); offset += chunk.length }
    return output
  }

  /** Consumers publish only after full iteration, including final digest and access checks. */
  downloadStream(descriptorInput: BlobDescriptor, locatorInput: AttachmentLocator): AsyncGenerator<Uint8Array> {
    const descriptor = portableDescriptor(descriptorInput)
    const [locator] = parseAttachmentLocators([structuredClone(locatorInput)])
    if (!locator || locator.blobId !== descriptor.blobId) throw new Error("Attachment locator does not match the requested attachment")
    return this.receive(descriptor, locator)
  }

  private async *receive(descriptor: BlobDescriptor, locator: AttachmentLocator): AsyncGenerator<Uint8Array> {
    await this.guard()
    let state = await this.read(descriptor)
    if (state && canonicalBlindJson(state.locator) !== canonicalBlindJson(locator)) throw new Error("Attachment transfer locator changed")
    let object = await this.repository.object(locator.manifestId)
    if (!object) {
      await this.guard()
      object = await this.transport.download(this.access, locator.manifestId)
    }
    const manifest = await openAttachmentManifest(this.scope, descriptor, locator, object)
    await this.guard()
    if (!state) {
      state = { version: 1, generation: 0, binding: await this.binding, descriptor, locator,
        objects: manifest.chunks.map(chunk => ({ objectId: chunk.objectId, requestId: crypto.randomUUID() }))
          .concat({ objectId: locator.manifestId, requestId: crypto.randomUUID() }),
        receipts: {}, received: [locator.manifestId] }
      await this.repository.commit(null, state, [{ objectId: locator.manifestId, object }])
    } else { this.requireManifestObjects(state, manifest) }
    const verifier = createBlobStreamVerifier(descriptor)
    for (const chunk of manifest.chunks) {
      await this.guard()
      let encrypted = await this.repository.object(chunk.objectId)
      if (!encrypted) encrypted = await this.transport.download(this.access, chunk.objectId)
      const bytes = await openAttachmentChunk(this.scope, descriptor, locator, manifest, chunk.index, encrypted)
      await this.guard()
      if (!state.received.includes(chunk.objectId)) {
        const next: AttachmentProgress = { ...state, generation: state.generation + 1, received: [...state.received, chunk.objectId] }
        await this.repository.commit(state.generation, next, [{ objectId: chunk.objectId, object: encrypted }])
        state = next
      }
      verifier.update(bytes)
      yield bytes
    }
    verifier.finish()
    await this.guard()
  }

  private async read(descriptor: BlobDescriptor): Promise<AttachmentProgress | null> {
    const state = await this.repository.read()
    await this.guard()
    if (!state) return null
    parseAttachmentLocators([state.locator])
    const binding = await this.binding
    if (state.binding !== binding) return this.migrateLegacy(state, descriptor, binding)
    if (!validProgressHeader(state, binding, descriptor)) throw new Error("Invalid attachment progress or credential binding")
    assertProgressObjects(state, descriptor)
    return state
  }

  private async migrateLegacy(state: AttachmentProgress, descriptor: BlobDescriptor, binding: string): Promise<AttachmentProgress> {
    const legacy = await this.legacyBinding
    if (!validProgressHeader(state, legacy, descriptor) || !this.repository.migrateBinding) {
      throw new Error("Saved file transfer cannot resume with this connection. Restore its original Rusty access and retry.")
    }
    assertProgressObjects(state, descriptor)
    await this.validatePrepared(state)
    await this.guard()
    const next = { ...state, generation: state.generation + 1, binding }
    await this.repository.migrateBinding(state.generation, state.binding, next)
    await this.guard()
    return next
  }

  private async requireObject(id: string): Promise<BlindObject> {
    const object = await this.repository.object(id)
    if (!object || await blindObjectId(object) !== id) throw new Error("Prepared attachment ciphertext is missing or corrupt")
    return object
  }

  private requireManifestObjects(state: AttachmentProgress, manifest: AttachmentManifest) {
    const expected = [...manifest.chunks.map(chunk => chunk.objectId), state.locator.manifestId]
    if (canonicalBlindJson(expected) !== canonicalBlindJson(state.objects.map(item => item.objectId))) {
      throw new Error("Attachment progress does not match its authenticated manifest")
    }
  }

  private async validatePrepared(state: AttachmentProgress) {
    const fingerprint = canonicalBlindJson(state)
    if (this.validated.has(fingerprint)) return
    const manifest = await openAttachmentManifest(this.scope, state.descriptor, state.locator,
      await this.requireObject(state.locator.manifestId))
    this.requireManifestObjects(state, manifest)
    for (const item of state.objects) {
      const receipt = state.receipts[item.objectId]
      if (receipt) {
        const revision = receipt.payload.policyRevision
        if (!Number.isSafeInteger(revision) || revision < 0 || revision > this.access.policyRevision) {
          throw new Error("Stored attachment receipt belongs to a newer or invalid policy")
        }
        // A historical durable receipt remains evidence for immutable bytes; live replies must match current access exactly.
        await verifyBlindBlobReceipt(receipt, { ...this.access, policyRevision: revision }, await this.requireObject(item.objectId), item.requestId)
      }
    }
    this.validated.clear()
    this.validated.add(fingerprint)
  }
}
