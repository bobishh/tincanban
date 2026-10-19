import type { BlindServiceCapabilities } from "./blindServiceCapabilities"
import { fetchBlind, readBlindJson } from "./rustyHttp"
import {
  canonicalRustyJson,
  decodeBlindBytes,
  downloadRustyObject,
  encodeBlindBytes,
  inventoryRustyObjects,
  rustyHash,
  rustyObjectId,
  rustyProducerHeaders,
  rustyOrigin,
  uploadRustyObject,
  verifyRustyStorageReceipt,
  type BlindObject,
  type RustyReplicaAccess,
  type RustyStorageReceipt,
} from "@meta-uber/mesh-replication/rusty-replica"

export { decodeBlindBytes, encodeBlindBytes, type BlindObject }
export type BlindAccess = RustyReplicaAccess
export type BlindReceipt = RustyStorageReceipt

function appAccess(access: BlindAccess): BlindAccess {
  return { ...access, client: access.client ?? "tincanban" }
}

export const canonicalBlindJson = canonicalRustyJson
export const blindHash = rustyHash
export const blindObjectId = rustyObjectId
export const blindProducerHeaders = (access: BlindAccess) => rustyProducerHeaders(appAccess(access))
export async function verifyBlindReceipt(receipt: BlindReceipt, access: BlindAccess, object: BlindObject, requestId: string): Promise<void> {
  return verifyRustyStorageReceipt(receipt, access, object, requestId)
}
export async function uploadBlindObject(access: BlindAccess, object: BlindObject, requestId: string = crypto.randomUUID(), observedSequence = 0): Promise<BlindReceipt> {
  return uploadRustyObject(appAccess(access), object, requestId, observedSequence, fetchBlind)
}
export async function inventoryBlindObjects(access: BlindAccess, after: number): ReturnType<typeof inventoryRustyObjects> {
  return inventoryRustyObjects(appAccess(access), after, fetchBlind)
}
export async function downloadBlindObject(access: BlindAccess, id: string): Promise<BlindObject> {
  return downloadRustyObject(appAccess(access), id, fetchBlind)
}

export async function discoverBlindKeeper(input: string): Promise<{ origin: string; servicePublicKey: string; serviceId: string; snapshotCheckpoints?: 1; snapshotWriteFence?: 1; scopeManagement?: 1; personManagement?: 1; scopeEnrollmentRetry?: 1;
  encryptedBlobs?: { version: 1; maximumCiphertextBytes: number }; writerPolicy?: { version: 1; maximumWriterVersion: 2 };
  blobCoverage?: { version: 1; maximumObjects: 33 }; encryptedArchives?: { version: 1; maximumCiphertextBytes: 262160 };
  archiveCoverageBatches?: { version: 1; maximumObjects: 64 }; archiveCoverageAggregates?: { version: 1; maximumChildren: 8; maximumHeight: 31 } }> {
  const origin = rustyOrigin(input)
  const descriptor = await readBlindJson<{ protocolVersions: number[]; publicOrigin: string; service: { serviceId: string; publicKey: string };
    capabilities: BlindServiceCapabilities }>(await fetchBlind(`${origin}/.well-known/mesh-lighthouse`, { signal: AbortSignal.timeout(10000) }), 16384)
  if (!descriptor.protocolVersions?.includes(2) || descriptor.publicOrigin !== origin || !descriptor.capabilities?.modes?.includes("blind") ||
    descriptor.capabilities.applicationWrites !== false || descriptor.capabilities.classification !== false ||
    !descriptor.service || await blindHash(decodeBlindBytes(descriptor.service.publicKey)) !== descriptor.service.serviceId) {
    throw new Error("This service does not support blind Rusty replication")
  }
  return { origin, servicePublicKey: descriptor.service.publicKey, serviceId: descriptor.service.serviceId,
    ...(await import("./blindServiceCapabilities")).supportedManagementFeatures(descriptor.capabilities) }
}
