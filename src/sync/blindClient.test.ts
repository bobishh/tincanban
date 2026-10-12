import { expect, test, vi } from "vitest"
import { blindHash, blindObjectId, canonicalBlindJson, inventoryBlindObjects, verifyBlindReceipt, type BlindAccess, type BlindReceipt } from "./blindClient"
import { encodeBlindBytes, encryptBlindObject } from "./blindEnvelope"

test("Given workerd fetch, when reading Rusty, then uses manual redirect handling and rejects redirects", async () => {
  const access: BlindAccess = { origin: "http://localhost:8080", scopeId: "scope", servicePublicKey: "unused", readToken: "read", writeToken: "write", policyRevision: 1 }
  let redirect = false
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    if (init.redirect !== "manual") throw new Error("workerd only supports manual or follow")
    return redirect ? new Response(null, { status: 302, headers: { location: "https://other.example" } })
      : Response.json({ objects: [], cursor: 0, hasMore: false })
  }))
  try {
    await expect(inventoryBlindObjects(access, 0)).resolves.toEqual({ objects: [], cursor: 0, hasMore: false })
    redirect = true
    await expect(inventoryBlindObjects(access, 0)).rejects.toThrow(/redirect/i)
  } finally { vi.unstubAllGlobals() }
})

test("durable receipt binds pinned service, ciphertext, scope, epoch, policy and fresh request", async () => {
  const signingKey = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const publicKey = encodeBlindBytes(new Uint8Array(await crypto.subtle.exportKey("raw", signingKey.publicKey)))
  const serviceId = await blindHash(new Uint8Array(await crypto.subtle.exportKey("raw", signingKey.publicKey)))
  const object = await encryptBlindObject("scope", 1, crypto.getRandomValues(new Uint8Array(32)), new Uint8Array([1, 2, 3]))
  const access: BlindAccess = { origin: "http://localhost:8080", scopeId: "scope", servicePublicKey: publicKey, readToken: "read", writeToken: "write", policyRevision: 1 }
  const payload: BlindReceipt["payload"] = { kind: "blind-storage-receipt", version: 2, serviceId, scopeId: "scope", keyEpoch: 1,
    objectId: await blindObjectId(object), sequence: 1, policyRevision: 1, requestId: "fresh-request" }
  const sign = async (value: BlindReceipt["payload"]): Promise<BlindReceipt> => ({ payload: value, signerKeyId: serviceId,
    signature: encodeBlindBytes(new Uint8Array(await crypto.subtle.sign("Ed25519", signingKey.privateKey,
      new TextEncoder().encode(`RUSTY/2/${value.kind}\0${canonicalBlindJson(value)}`)))) })
  const receipt = await sign(payload)
  await expect(verifyBlindReceipt(receipt, access, object, "fresh-request")).resolves.toBeUndefined()
  for (const patch of [{ scopeId: "other" }, { keyEpoch: 2 }, { policyRevision: 2 }, { sequence: 0 }, { objectId: "other" }, { requestId: "previous-request" }]) {
    await expect(verifyBlindReceipt(await sign({ ...payload, ...patch }), access, object, "fresh-request")).rejects.toThrow("does not cover")
  }
  await expect(verifyBlindReceipt({ ...receipt, signature: encodeBlindBytes(new Uint8Array(64)) }, access, object, "fresh-request")).rejects.toThrow("signature invalid")
  await expect(verifyBlindReceipt(receipt, { ...access, servicePublicKey: encodeBlindBytes(new Uint8Array(32)) }, object, "fresh-request")).rejects.toThrow("does not cover")
})

test("Inventory metadata cannot claim a completed pass while withholding newer objects", async () => {
  const access: BlindAccess = { origin: "http://localhost:8080", scopeId: "scope", servicePublicKey: "unused", readToken: "read", writeToken: "write", policyRevision: 1, client: "automation", clientBuild: "a".repeat(40) }
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers)
    expect(headers.get("X-Rusty-Client")).toBe("automation")
    expect(headers.get("X-Rusty-Build")).toBe("a".repeat(40))
    return Response.json({ objects: [], cursor: 0, hasMore: false, objectCount: 8, maxSequence: 8 })
  }))
  try { await expect(inventoryBlindObjects(access, 0)).rejects.toThrow("Invalid Rusty checkpoint inventory") }
  finally { vi.unstubAllGlobals() }
})

test("Inventory permits one durable checkpoint repair slot above normal capacity, but rejects unbounded overflow", async () => {
  const access: BlindAccess = { origin: "http://localhost:8080", scopeId: "scope", servicePublicKey: "unused", readToken: "read", writeToken: "write", policyRevision: 1 }
  let objectCount = 10001
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ objects: [], cursor: 10001, hasMore: false, objectCount, maxSequence: 10001 })))
  try {
    await expect(inventoryBlindObjects(access, 10001)).resolves.toMatchObject({ objectCount: 10001 })
    objectCount = 10002
    await expect(inventoryBlindObjects(access, 10001)).rejects.toThrow("Invalid Rusty checkpoint inventory")
  } finally { vi.unstubAllGlobals() }
})
