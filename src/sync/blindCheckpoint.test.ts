import { expect, test } from "vitest"
import { signEnvelope, publicKeyId } from "../domain/identity"
import { prepareBlindCheckpoint, verifyCheckpointReceipt, type BlindCheckpointReceipt } from "./blindCheckpoint"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { encodeBlindBytes, encryptBlindObject } from "./blindEnvelope"
import { blindHash, canonicalBlindJson, type BlindAccess } from "./blindClient"

test("Checkpoint receipt cryptographically covers replacement, exact prefix, request and owner authorization", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Fixture owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const publicKey = encodeBlindBytes(new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey)))
  const serviceId = await publicKeyId(publicKey)
  const access: BlindAccess = { origin: "http://localhost:8080", scopeId: "opaque", servicePublicKey: publicKey, readToken: "read", writeToken: "write", policyRevision: 1 }
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
