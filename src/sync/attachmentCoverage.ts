import { validateBlobDescriptor, type BlobDescriptor } from "@meta-uber/mesh-blob"
import type { BlindAccess } from "./blindClient"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { decodeBlindBytes, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { downloadBlindBlob } from "./blindBlobClient"
import { openAttachmentManifest, type AttachmentScope } from "./attachmentCodec"
import type { AttachmentLocator } from "../product-replica"
import { requestBlindBlobCoverage, type BlindBlobCoverageReceipt } from "./blindBlobCoverage"
import { parseReplicaContentKeys } from "./replicaContentKeys"

const ID = /^[A-Za-z0-9_-]{1,128}$/
const HASH = /^[A-Za-z0-9_-]{43}$/

function captureScope(value: AttachmentScope): AttachmentScope {
  const scope = structuredClone(value)
  if (!scope || typeof scope !== "object" || Array.isArray(scope) ||
    !["workspaceId", "scopeId", "keyEpoch", "contentKey"].every(key => Object.hasOwn(scope, key)) ||
    Object.keys(scope).some(key => !["workspaceId", "scopeId", "keyEpoch", "contentKey", "historicalContentKeys", "historicalContentKeyVariants"].includes(key))) {
    throw new Error("Invalid attachment coverage scope")
  }
  if (!validWorkspace(scope.workspaceId) || !validScope(scope.scopeId) || !validEpoch(scope.keyEpoch)) {
    throw new Error("Invalid attachment coverage scope")
  }
  parseReplicaContentKeys(scope)
  return scope
}

function validWorkspace(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value === value.trim() && value.length <= 256
}

function validScope(value: unknown): value is string { return typeof value === "string" && ID.test(value) }

function validEpoch(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1 }

function captureAccess(value: BlindAccess, scope: AttachmentScope): BlindAccess {
  const access = structuredClone(value)
  if (!access || access.scopeId !== scope.scopeId || typeof access.readToken !== "string" || !access.readToken ||
    typeof access.servicePublicKey !== "string" || !Number.isSafeInteger(access.policyRevision) || access.policyRevision < 0) {
    throw new Error("Attachment coverage access does not match its scope")
  }
  access.origin = blindOrigin(access.origin)
  if (decodeBlindBytes(access.servicePublicKey).length !== 32) throw new Error("Invalid Rusty service pin")
  return access
}

function captureDescriptor(value: BlobDescriptor): BlobDescriptor {
  const descriptor = structuredClone(value)
  const allowed = ["kind", "version", "blobId", "name", "mediaType", "size", "hash", "ticket"]
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor) ||
    Object.keys(descriptor).some(key => !allowed.includes(key))) throw new Error("Invalid attachment coverage descriptor")
  delete descriptor.ticket
  validateBlobDescriptor(descriptor)
  return descriptor
}

function captureLocator(value: AttachmentLocator, descriptor: BlobDescriptor): AttachmentLocator {
  const locator = structuredClone(value)
  if (!locator || typeof locator !== "object" || Array.isArray(locator) || Object.keys(locator).length !== 4 ||
    locator.version !== 1 || locator.blobId !== descriptor.blobId || typeof locator.transferId !== "string" ||
    !ID.test(locator.transferId) || typeof locator.manifestId !== "string" || !HASH.test(locator.manifestId)) {
    throw new Error("Attachment coverage locator does not match its descriptor")
  }
  return locator
}

/** Confirm immutable attachment ciphertext exists without downloading chunks or contacting its original peer. */
export async function confirmRustyAttachmentCoverage(scopeInput: AttachmentScope, accessInput: BlindAccess,
  descriptorInput: BlobDescriptor, locatorInput: AttachmentLocator, guard: () => Promise<void>): Promise<BlindBlobCoverageReceipt> {
  const scope = captureScope(scopeInput)
  const access = captureAccess(accessInput, scope)
  const descriptor = captureDescriptor(descriptorInput)
  const locator = captureLocator(locatorInput, descriptor)
  await guard()

  const manifestObject: BlindObject = await downloadBlindBlob(access, locator.manifestId)
  await guard()
  const manifest = await openAttachmentManifest(scope, descriptor, locator, manifestObject)
  await guard()
  const objects = [{ objectId: locator.manifestId, keyEpoch: manifestObject.keyEpoch },
    ...manifest.chunks.map(chunk => ({ objectId: chunk.objectId, keyEpoch: manifestObject.keyEpoch }))]
  const receipt = await requestBlindBlobCoverage(access, objects)
  await guard()
  return receipt
}
