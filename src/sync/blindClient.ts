/* global __TINCANBAN_BUILD_COMMIT__ */
import { z } from "zod"
import { verifyEnvelope } from "../domain/identity"
import type { BlindServiceCapabilities } from "./blindServiceCapabilities"
import { blindOrigin } from "./blindOrigin"
export { blindOrigin } from "./blindOrigin"
import { decodeBlindBytes, encodeBlindBytes, type BlindObject } from "./blindEnvelope"

export type BlindAccess = { origin: string; scopeId: string; servicePublicKey: string; readToken: string; writeToken: string; policyRevision: number; client?: "tincanban" | "automation"; clientBuild?: string }
export type BlindReceipt = { payload: { kind: "blind-storage-receipt"; version: 2; serviceId: string; scopeId: string; keyEpoch: number;
  objectId: string; sequence: number; policyRevision: number; requestId: string }; signerKeyId: string; signature: string }
const encoder = new TextEncoder()
const policyId = z.string().min(1).max(128)
const policyHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const scopePolicyReceiptSchema = z.strictObject({
  signerKeyId: policyHash, signature: z.string().min(1).max(128),
  payload: z.strictObject({ kind: z.literal("rusty-scope-policy-receipt"), version: z.literal(1), serviceId: policyHash,
    scopeId: policyId, personId: policyId, revision: z.number().int().positive().refine(Number.isSafeInteger), revoked: z.boolean(),
    challengeId: policyId, authorizationHash: policyHash, minimumWriterVersion: z.literal(2).optional() }),
})
export type RustyScopePolicyReceipt = z.infer<typeof scopePolicyReceiptSchema>
type RustyPolicyStorage = { scopeId: string; servicePublicKey: string }

/** Structural parsing is safe during a local transaction; callers verify cryptography before using saved evidence. */
export function parseRustyScopePolicyReceipt(value: unknown): RustyScopePolicyReceipt {
  return scopePolicyReceiptSchema.parse(structuredClone(value))
}

/** A service receipt confirms only storage policy. Current Owner requests separately authorize maintenance. */
export async function verifyRustyWriterPolicyReceipt(value: unknown, storageValue: RustyPolicyStorage,
  personId: string, minimumRevision: number): Promise<RustyScopePolicyReceipt> {
  const receipt = parseRustyScopePolicyReceipt(value)
  const storage = structuredClone(storageValue)
  const payload = receipt.payload
  const key = decodeBlindBytes(storage.servicePublicKey)
  if (key.length !== 32 || !Number.isSafeInteger(minimumRevision) || minimumRevision < 0 ||
    payload.scopeId !== storage.scopeId || payload.personId !== personId || payload.revoked ||
    payload.minimumWriterVersion !== 2 || payload.revision < minimumRevision ||
    receipt.signerKeyId !== payload.serviceId || payload.serviceId !== await blindHash(key) ||
    !await verifyEnvelope(receipt, storage.servicePublicKey, "RUSTY/2")) throw new Error("Rusty receipt does not confirm this writer policy")
  return receipt
}

export function canonicalBlindJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalBlindJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalBlindJson(item)}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("Invalid JSON value")
  return encoded
}
export async function blindHash(bytes: Uint8Array): Promise<string> {
  return encodeBlindBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))))
}
export async function blindObjectId(object: BlindObject): Promise<string> { return blindHash(encoder.encode(canonicalBlindJson(object))) }


export async function fetchBlind(url: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  if (!headers.has("X-Rusty-Client")) headers.set("X-Rusty-Client", "tincanban")
  const build = typeof __TINCANBAN_BUILD_COMMIT__ === "undefined" ? "" : __TINCANBAN_BUILD_COMMIT__
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(build) && !headers.has("X-Rusty-Build")) headers.set("X-Rusty-Build", build)
  const response = await fetch(url, { ...init, headers, redirect: "manual" })
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new Error("Rusty redirects are not allowed")
  }
  return response
}

export async function readBlindJson<T>(response: Response, maximumBytes = 32 * 1024 * 1024): Promise<T> {
  if (!response.body) throw new Error("Empty Rusty response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.length
      if (length > maximumBytes) { await reader.cancel(); throw new Error("Rusty response too large") }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T
  if (!response.ok) {
    const error = value as { message?: string; code?: string }
    throw Object.assign(new Error(error.message || `Rusty returned HTTP ${response.status}`), { code: error.code, status: response.status })
  }
  return value
}

export async function discoverBlindKeeper(input: string): Promise<{ origin: string; servicePublicKey: string; serviceId: string; snapshotCheckpoints?: 1; scopeManagement?: 1; personManagement?: 1;
  encryptedBlobs?: { version: 1; maximumCiphertextBytes: number }; writerPolicy?: { version: 1; maximumWriterVersion: 2 };
  blobCoverage?: { version: 1; maximumObjects: 33 }; encryptedArchives?: { version: 1; maximumCiphertextBytes: 262160 };
  archiveCoverageBatches?: { version: 1; maximumObjects: 64 }; archiveCoverageAggregates?: { version: 1; maximumChildren: 8; maximumHeight: 31 } }> {
  const origin = blindOrigin(input)
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

export async function verifyBlindReceipt(receipt: BlindReceipt, access: BlindAccess, object: BlindObject, requestId: string): Promise<void> {
  const payload = receipt.payload
  const serviceId = await blindHash(decodeBlindBytes(access.servicePublicKey))
  if (!payload || payload.kind !== "blind-storage-receipt" || payload.version !== 2 || payload.serviceId !== serviceId || receipt.signerKeyId !== serviceId ||
    payload.scopeId !== access.scopeId || payload.keyEpoch !== object.keyEpoch || payload.objectId !== await blindObjectId(object) ||
    payload.requestId !== requestId || !Number.isSafeInteger(payload.sequence) || payload.sequence < 1 || payload.policyRevision !== access.policyRevision) {
    throw new Error("Rusty receipt does not cover this encrypted object")
  }
  const publicKey = await crypto.subtle.importKey("raw", decodeBlindBytes(access.servicePublicKey), "Ed25519", false, ["verify"])
  const message = encoder.encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)
  if (!await crypto.subtle.verify("Ed25519", publicKey, decodeBlindBytes(receipt.signature), message)) throw new Error("Rusty receipt signature invalid")
}

export async function uploadBlindObject(access: BlindAccess, object: BlindObject, requestId: string = crypto.randomUUID()): Promise<BlindReceipt> {
  const id = await blindObjectId(object)
  const receipt = await readBlindJson<BlindReceipt>(await fetchBlind(`${blindOrigin(access.origin)}/v2/scopes/${access.scopeId}/objects/${id}?writerVersion=2`, {
    method: "PUT", signal: AbortSignal.timeout(30000),
    headers: { ...blindProducerHeaders(access), Authorization: `Bearer ${access.writeToken}`, "Content-Type": "application/json", "X-Rusty-Request-Id": requestId }, body: JSON.stringify(object),
  }), 16384)
  await verifyBlindReceipt(receipt, access, object, requestId)
  return receipt
}
export async function inventoryBlindObjects(access: BlindAccess, after: number): Promise<{ objects: Array<{ objectId: string; sequence: number }>; cursor: number; hasMore: boolean; objectCount?: number; maxSequence?: number }> {
  const result = await readBlindJson<{ objects: Array<{ objectId: string; sequence: number }>; cursor: number; hasMore: boolean; objectCount?: number; maxSequence?: number }>(
    await fetchBlind(`${blindOrigin(access.origin)}/v2/scopes/${access.scopeId}/objects?after=${after}`, {
      signal: AbortSignal.timeout(15000), headers: { ...blindProducerHeaders(access), Authorization: `Bearer ${access.readToken}` },
    }), 65536)
  if (!Array.isArray(result.objects) || result.objects.length > 128 || typeof result.hasMore !== "boolean" || !Number.isSafeInteger(result.cursor) || result.cursor < after ||
    result.objects.some((object, index) => !/^[A-Za-z0-9_-]{43}$/.test(object.objectId) || !Number.isSafeInteger(object.sequence) || object.sequence <= (result.objects[index - 1]?.sequence ?? after)) ||
    result.cursor !== (result.objects.at(-1)?.sequence ?? after) || result.hasMore && result.objects.length === 0) throw new Error("Invalid Rusty inventory")
  validateCheckpointInventory(result)
  return result
}
export async function downloadBlindObject(access: BlindAccess, id: string): Promise<BlindObject> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new Error("Invalid encrypted object ID")
  const object = await readBlindJson<BlindObject>(await fetchBlind(`${blindOrigin(access.origin)}/v2/scopes/${access.scopeId}/objects/${id}`, {
    signal: AbortSignal.timeout(30000), headers: { ...blindProducerHeaders(access), Authorization: `Bearer ${access.readToken}` },
  }))
  if (object.scopeId !== access.scopeId || await blindObjectId(object) !== id) throw new Error("Rusty object integrity failure")
  return object
}

// One fsynced checkpoint may temporarily exceed the normal 10,000-object cap before manifest recovery.
function validateCheckpointInventory(result: { objectCount?: number; maxSequence?: number; cursor: number; hasMore: boolean }): void {
  if (result.objectCount !== undefined && (!Number.isSafeInteger(result.objectCount) || result.objectCount < 0 || result.objectCount > 10001) ||
    result.maxSequence !== undefined && (!Number.isSafeInteger(result.maxSequence) || result.maxSequence < result.cursor ||
      !result.hasMore && result.maxSequence !== result.cursor)) throw new Error("Invalid Rusty checkpoint inventory")
}

export function blindProducerHeaders(access: BlindAccess): Record<string, string> {
  return { "X-Rusty-Client": access.client ?? "tincanban", ...(access.clientBuild && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(access.clientBuild) ? { "X-Rusty-Build": access.clientBuild } : {}) }
}
