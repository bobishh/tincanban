import { afterEach, expect, test, vi } from "vitest"
import { signEnvelope, publicKeyId } from "../domain/identity"
import { prepareBlindCheckpoint, submitBlindCheckpoint, verifyCheckpointReceipt, type BlindCheckpointReceipt } from "./blindCheckpoint"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { decodeBlindBytes, encodeBlindBytes, encryptBlindObject } from "./blindEnvelope"
import { blindHash, canonicalBlindJson, type BlindAccess } from "./blindClient"
import { RustyManagementRepository } from "./rustyManagementRepository"

afterEach(() => { vi.unstubAllGlobals(); resetIdentityStorageForTest() })

async function advertiseWriterPolicy(access: BlindAccess, writerPolicy?: unknown) {
  const serviceId = await blindHash(decodeBlindBytes(access.servicePublicKey))
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ protocolVersions: [2], publicOrigin: access.origin,
    service: { serviceId, publicKey: access.servicePublicKey }, capabilities: { modes: ["blind"], applicationWrites: false,
      classification: false, ...(writerPolicy === undefined ? {} : { writerPolicy }) } })))
}

test("Given explicit scope authority, when preparing a checkpoint or losing its operation, then bind management revision and reject stale prepared requests", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const servicePublicKey = encodeBlindBytes(new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey)))
  const serviceId = await publicKeyId(servicePublicKey)
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: "opaque", servicePublicKey, readToken: "read", writeToken: "write", policyRevision: 1 }
  await advertiseWriterPolicy(access)
  const binding = { origin: access.origin, servicePublicKey, resourceKind: "scope" as const, resourceId: access.scopeId }
  const repository = new RustyManagementRepository(profile.identity.personId)
  const capability = await signEnvelope(service.privateKey, { kind: "rusty-scope-management-capability" as const, version: 1 as const,
    serviceId, origin: access.origin, personId: profile.identity.personId, resourceKind: "scope" as const, resourceId: access.scopeId,
    revision: 1, operations: ["management.update", "snapshot.checkpoint"], revokedDeviceIds: [], requestId: "policy-request",
    authorizationHash: "A".repeat(43), issuedAt: Date.now() }, serviceId, "RUSTY/2")
  await repository.observe(binding, capability)
  const object = await encryptBlindObject(access.scopeId, 1, crypto.getRandomValues(new Uint8Array(32)), new Uint8Array([1]))
  const request = await prepareBlindCheckpoint(access, object, 8, profile)
  expect(request).toHaveProperty("managementCapability", capability)
  expect(request.authorization.payload).toHaveProperty("managementRevision", 1)
  const receipt = await signEnvelope(service.privateKey, { kind: "rusty-snapshot-checkpoint-receipt" as const, version: 1 as const,
    serviceId, scopeId: access.scopeId, keyEpoch: 1, objectId: request.authorization.payload.objectId, sequence: 9,
    supersedesThrough: 8, policyRevision: 1, requestId: request.authorization.payload.requestId,
    authorizationHash: await blindHash(new TextEncoder().encode(canonicalBlindJson(request.authorization))) }, serviceId, "RUSTY/2")
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    expect(JSON.parse(String(init.body)).managementCapability).toEqual(capability)
    return Response.json(receipt)
  })
  vi.stubGlobal("fetch", fetch)
  try {
    expect(await submitBlindCheckpoint(access, request)).toEqual(receipt)
  } finally { vi.unstubAllGlobals() }
  await repository.observe(binding, await signEnvelope(service.privateKey, { ...capability.payload, revision: 2, operations: ["management.update"] }, serviceId, "RUSTY/2"))
  await advertiseWriterPolicy(access)
  await expect(prepareBlindCheckpoint(access, object, 8, profile)).rejects.toThrow(/operation|authorize/i)
  await expect(submitBlindCheckpoint(access, request)).rejects.toThrow(/stale|authority|revision/i)
  expect(fetch).toHaveBeenCalledTimes(1)
})

test("Given an invalid private-key binding, when preparing retention deletion, then no checkpoint authorization is returned", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const access: BlindAccess = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: profile.device.publicKey,
    readToken: "read", writeToken: "write", policyRevision: 1 }
  await advertiseWriterPolicy(access)
  const object = await encryptBlindObject(access.scopeId, 1, crypto.getRandomValues(new Uint8Array(32)), new Uint8Array([1]))
  await expect(prepareBlindCheckpoint(access, object, 8, { ...profile,
    privateKeys: { devicePrivateKey: other.privateKey } })).rejects.toThrow(/key|signer/)
})

test("Checkpoint receipt cryptographically covers replacement, exact prefix, request and owner authorization", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Fixture owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const publicKey = encodeBlindBytes(new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey)))
  const serviceId = await publicKeyId(publicKey)
  const access: BlindAccess = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: publicKey, readToken: "read", writeToken: "write", policyRevision: 1 }
  await advertiseWriterPolicy(access)
  const object = await encryptBlindObject(access.scopeId, 1, crypto.getRandomValues(new Uint8Array(32)), new Uint8Array([1, 2, 3]))
  const request = await prepareBlindCheckpoint(access, object, 8, profile)
  const authorizationHash = await blindHash(new TextEncoder().encode(canonicalBlindJson(request.authorization)))
  const payload: BlindCheckpointReceipt["payload"] = { kind: "rusty-snapshot-checkpoint-receipt", version: 1, serviceId, scopeId: access.scopeId,
    keyEpoch: 1, objectId: request.authorization.payload.objectId, sequence: 9, supersedesThrough: 8, policyRevision: 1,
    requestId: request.authorization.payload.requestId, authorizationHash }
  const receipt = await signEnvelope(service.privateKey, payload, serviceId, "RUSTY/2")
  await expect(verifyCheckpointReceipt(receipt, access, request)).resolves.toBeUndefined()
  for (const patch of [{ supersedesThrough: 9 }, { sequence: 10 }, { policyRevision: 2 }, { authorizationHash: "other" }, { objectId: "other" }, { requestId: "other" }, { scopeId: "other" }, { keyEpoch: 2 }]) {
    await expect(verifyCheckpointReceipt(await signEnvelope(service.privateKey, { ...payload, ...patch }, serviceId, "RUSTY/2"), access, request)).rejects.toThrow("does not cover")
  }
  await expect(verifyCheckpointReceipt({ ...receipt, signature: encodeBlindBytes(new Uint8Array(64)) }, access, request)).rejects.toThrow("signature invalid")
  const publicRequest = JSON.stringify(request)
  expect(publicRequest).not.toContain("privateKeys")
  expect(publicRequest).not.toContain("contentKey")
})

test("Given advertised writer policy, when preparing checkpoints, then sign writer version two only when available", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Writer policy owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const servicePublicKey = encodeBlindBytes(new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey)))
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: "writer-policy-scope", servicePublicKey,
    readToken: "read", writeToken: "write", policyRevision: 1 }
  const object = await encryptBlindObject(access.scopeId, 1, crypto.getRandomValues(new Uint8Array(32)), new Uint8Array([1]))
  await advertiseWriterPolicy(access, { version: 1, maximumWriterVersion: 2 })
  const upgraded = await prepareBlindCheckpoint(access, object, 4, profile)
  expect(upgraded.authorization.payload.writerVersion).toBe(2)

  await advertiseWriterPolicy(access)
  const legacy = await prepareBlindCheckpoint(access, object, 4, profile)
  expect(Object.hasOwn(legacy.authorization.payload, "writerVersion")).toBe(false)
})
