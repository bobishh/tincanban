import { expect, test, vi } from "vitest"
import { blindHash, blindObjectId, canonicalBlindJson, discoverBlindKeeper, inventoryBlindObjects, uploadBlindObject,
  verifyBlindReceipt, type BlindAccess, type BlindReceipt } from "./blindClient"
import { encodeBlindBytes, encryptBlindObject } from "./blindEnvelope"

test("Given an advertised required management protocol, when its version is unknown, then do not interpret it as a legacy server", async () => {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))
  const origin = "https://rusty.example"
  const service = { serviceId: await blindHash(raw), publicKey: encodeBlindBytes(raw) }
  let scopeManagement: { version: number } | null = { version: 2 }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ protocolVersions: [2], publicOrigin: origin, service,
    capabilities: { modes: ["blind"], applicationWrites: false, classification: false, scopeManagement } })))
  try {
    await expect(discoverBlindKeeper(origin)).rejects.toThrow(/management|upgrade/i)
    scopeManagement = null
    await expect(discoverBlindKeeper(origin)).rejects.toThrow(/management|upgrade/i)
    scopeManagement = { version: 1 }
    expect(await discoverBlindKeeper(origin)).toMatchObject({ scopeManagement: 1 })
  } finally { vi.unstubAllGlobals() }
})

test("Given a person management advertisement, when discovery validates the descriptor, then only version one is recognized", async () => {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))
  const origin = "https://rusty.example"
  const service = { serviceId: await blindHash(raw), publicKey: encodeBlindBytes(raw) }
  let personManagement: unknown = { version: 1 }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ protocolVersions: [2], publicOrigin: origin, service,
    capabilities: { modes: ["blind"], applicationWrites: false, classification: false, personManagement } })))
  try {
    await expect(discoverBlindKeeper(origin)).resolves.toMatchObject({ personManagement: 1 })
    for (const unsupported of [{ version: 2 }, null, {}, "v1"]) {
      personManagement = unsupported
      await expect(discoverBlindKeeper(origin)).rejects.toThrow(/management|upgrade/i)
    }
    personManagement = undefined
    await expect(discoverBlindKeeper(origin)).resolves.not.toHaveProperty("personManagement")
  } finally { vi.unstubAllGlobals() }
})

test("Given writer policy discovery, when the advertised maximum is unknown or malformed, then fail closed", async () => {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))
  const origin = "https://rusty.example"
  const service = { serviceId: await blindHash(raw), publicKey: encodeBlindBytes(raw) }
  let writerPolicy: unknown = { version: 1, maximumWriterVersion: 2 }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ protocolVersions: [2], publicOrigin: origin, service,
    capabilities: { modes: ["blind"], applicationWrites: false, classification: false, writerPolicy } })))
  try {
    await expect(discoverBlindKeeper(origin)).resolves.toMatchObject({ writerPolicy: { version: 1, maximumWriterVersion: 2 } })
    for (const unsupported of [{ version: 2, maximumWriterVersion: 2 }, { version: 1, maximumWriterVersion: 1 },
      { version: 1, maximumWriterVersion: 3 }, { version: 1, maximumWriterVersion: 2, extra: true }, null]) {
      writerPolicy = unsupported
      await expect(discoverBlindKeeper(origin)).rejects.toThrow(/writer|upgrade/i)
    }
    writerPolicy = undefined
    await expect(discoverBlindKeeper(origin)).resolves.not.toHaveProperty("writerPolicy")
  } finally { vi.unstubAllGlobals() }
})

test("Given a snapshot writer v2 client, when uploading, then select writer v2 without changing reads", async () => {
  const object = await encryptBlindObject("scope", 1, crypto.getRandomValues(new Uint8Array(32)), new Uint8Array([1]))
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: "scope", servicePublicKey: "unused",
    readToken: "read", writeToken: "write", policyRevision: 1 }
  let uploadedUrl = ""
  const fetch = vi.fn(async (input: RequestInfo | URL) => { uploadedUrl = String(input); return Response.json({}) })
  vi.stubGlobal("fetch", fetch)
  try {
    await expect(uploadBlindObject(access, object, "request-writer-version-2")).rejects.toThrow()
    expect(uploadedUrl).toMatch(/\/v2\/scopes\/scope\/objects\/[A-Za-z0-9_-]{43}\?writerVersion=2$/)
  }
  finally { vi.unstubAllGlobals() }
})

test("Given encrypted blob capability, when discovered, then only a bounded compatible version is accepted", async () => {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))
  const origin = "https://rusty.example"
  const service = { serviceId: await blindHash(raw), publicKey: encodeBlindBytes(raw) }
  let encryptedBlobs: unknown = { version: 1, maximumCiphertextBytes: 1048592 }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ protocolVersions: [2], publicOrigin: origin, service,
    capabilities: { modes: ["blind"], applicationWrites: false, classification: false, encryptedBlobs } })))
  try {
    await expect(discoverBlindKeeper(origin)).resolves.toMatchObject({ encryptedBlobs: { version: 1, maximumCiphertextBytes: 1048592 } })
    for (const unsupported of [{ version: 2, maximumCiphertextBytes: 1048592 }, { version: 1, maximumCiphertextBytes: 0 },
      { version: 1, maximumCiphertextBytes: 1048593 }, { version: 1, maximumCiphertextBytes: 1048592, extra: true }]) {
      encryptedBlobs = unsupported
      await expect(discoverBlindKeeper(origin)).rejects.toThrow(/blob|upgrade/i)
    }
    encryptedBlobs = undefined
    await expect(discoverBlindKeeper(origin)).resolves.not.toHaveProperty("encryptedBlobs")
  } finally { vi.unstubAllGlobals() }
})

test("Given a blob coverage advertisement, when discovered, then recognize only the exact bounded v1 contract", async () => {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))
  const origin = "https://rusty.example"
  const service = { serviceId: await blindHash(raw), publicKey: encodeBlindBytes(raw) }
  let blobCoverage: unknown = { version: 1, maximumObjects: 33 }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ protocolVersions: [2], publicOrigin: origin, service,
    capabilities: { modes: ["blind"], applicationWrites: false, classification: false, blobCoverage } })))
  try {
    await expect(discoverBlindKeeper(origin)).resolves.toMatchObject({ blobCoverage: { version: 1, maximumObjects: 33 } })
    for (const unsupported of [{ version: 2, maximumObjects: 33 }, { version: 1, maximumObjects: 32 },
      { version: 1, maximumObjects: 34 }, { version: 1, maximumObjects: 33, extra: true }, null, "v1"]) {
      blobCoverage = unsupported
      await expect(discoverBlindKeeper(origin)).rejects.toThrow(/blob coverage|upgrade/i)
    }
    blobCoverage = undefined
    await expect(discoverBlindKeeper(origin)).resolves.not.toHaveProperty("blobCoverage")
  } finally { vi.unstubAllGlobals() }
})

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
