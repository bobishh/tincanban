import { expect, test, vi } from "vitest"
import { blindHash, blindObjectId, canonicalBlindJson, type BlindAccess } from "./blindClient"
import { encodeBlindBytes, encryptBlindObject, type BlindObject } from "./blindEnvelope"
import { downloadBlindBlob, uploadBlindBlob, verifyBlindBlobReceipt, type BlindBlobReceipt } from "./blindBlobClient"

const scope = "private-scope"
const requestId = "upload-attempt-identifier-01"

async function serviceFixture() {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))
  const serviceId = await blindHash(raw)
  const access: BlindAccess = { origin: "https://rusty.example", scopeId: scope, servicePublicKey: encodeBlindBytes(raw),
    readToken: "read-token", writeToken: "write-token", policyRevision: 7 }
  return { access, key, serviceId }
}

async function signedReceipt(payload: BlindBlobReceipt["payload"], key: CryptoKey, signerKeyId: string): Promise<BlindBlobReceipt> {
  return { payload, signerKeyId, signature: encodeBlindBytes(new Uint8Array(await crypto.subtle.sign("Ed25519", key,
    new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)))) }
}

async function encryptedFixture(): Promise<BlindObject> {
  return encryptBlindObject(scope, 3, crypto.getRandomValues(new Uint8Array(32)), new Uint8Array([1, 2, 3]))
}

test("Given an encrypted attachment, when uploading, then request identity and signed durable receipt bind exact bytes", async () => {
  const { access, key, serviceId } = await serviceFixture()
  const object = await encryptedFixture()
  const objectId = await blindObjectId(object)
  const payload: BlindBlobReceipt["payload"] = { kind: "blind-blob-storage-receipt", version: 1, serviceId, scopeId: scope,
    keyEpoch: object.keyEpoch, objectId, policyRevision: access.policyRevision, requestId }
  const receipt = await signedReceipt(payload, key.privateKey, serviceId)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(`${access.origin}/v2/scopes/${scope}/blobs/${objectId}?writerVersion=2`)
    expect(init?.method).toBe("PUT")
    const headers = new Headers(init?.headers)
    expect(headers.get("Authorization")).toBe(`Bearer ${access.writeToken}`)
    expect(headers.get("X-Rusty-Request-Id")).toBe(requestId)
    expect(JSON.parse(String(init?.body))).toEqual(object)
    return Response.json(receipt)
  })
  vi.stubGlobal("fetch", fetch)
  try { await expect(uploadBlindBlob(access, object, requestId)).resolves.toEqual(receipt) }
  finally { vi.unstubAllGlobals() }
})

test("Given an attachment receipt, when scope, epoch, request, schema or signature differs, then reject it", async () => {
  const { access, key, serviceId } = await serviceFixture()
  const object = await encryptedFixture()
  const payload: BlindBlobReceipt["payload"] = { kind: "blind-blob-storage-receipt", version: 1, serviceId, scopeId: scope,
    keyEpoch: object.keyEpoch, objectId: await blindObjectId(object), policyRevision: access.policyRevision, requestId }
  const sign = (value: BlindBlobReceipt["payload"]) => signedReceipt(value, key.privateKey, serviceId)
  await expect(verifyBlindBlobReceipt(await sign(payload), access, object, requestId)).resolves.toBeUndefined()
  for (const patch of [{ scopeId: "other" }, { keyEpoch: 4 }, { policyRevision: 8 }, { requestId: "old" }, { objectId: "A".repeat(43) }]) {
    await expect(verifyBlindBlobReceipt(await sign({ ...payload, ...patch }), access, object, requestId)).rejects.toThrow()
  }
  await expect(verifyBlindBlobReceipt({ ...await sign(payload), payload: { ...payload, sequence: 1 } } as never,
    access, object, requestId)).rejects.toThrow()
  await expect(verifyBlindBlobReceipt({ ...await sign(payload), signature: encodeBlindBytes(new Uint8Array(64)) },
    access, object, requestId)).rejects.toThrow()
})

test("Given a stored encrypted attachment, when downloading, then verify canonical object ID and scope", async () => {
  const { access } = await serviceFixture()
  const object = await encryptedFixture()
  const id = await blindObjectId(object)
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(`${access.origin}/v2/scopes/${scope}/blobs/${id}`)
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${access.readToken}`)
    return Response.json(object)
  })
  vi.stubGlobal("fetch", fetch)
  try { await expect(downloadBlindBlob(access, id)).resolves.toEqual(object) }
  finally { vi.unstubAllGlobals() }
})

test("Given bad blob responses, when downloading, then reject tampering and preserve HTTP status and code", async () => {
  const { access } = await serviceFixture()
  const object = await encryptedFixture()
  const id = await blindObjectId(object)
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...object, scopeId: "foreign" })))
  try { await expect(downloadBlindBlob(access, id)).rejects.toThrow(/invalid|integrity|scope/i) }
  finally { vi.unstubAllGlobals() }
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "capacity_exceeded", message: "Storage capacity exceeded" }, { status: 507 })))
  try {
    await expect(uploadBlindBlob(access, object, requestId)).rejects.toMatchObject({ status: 507, code: "capacity_exceeded" })
  } finally { vi.unstubAllGlobals() }
})

test("Given an oversized or extended object response, when downloading, then enforce the bounded strict wire schema", async () => {
  const { access } = await serviceFixture()
  const object = await encryptedFixture()
  const id = await blindObjectId(object)
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...object, extra: "not part of BlindObject v1" })))
  try { await expect(downloadBlindBlob(access, id)).rejects.toThrow(/invalid encrypted attachment/i) }
  finally { vi.unstubAllGlobals() }
  vi.stubGlobal("fetch", vi.fn(async () => new Response(`{"padding":"${"x".repeat(2 * 1024 * 1024)}"}`)))
  try { await expect(downloadBlindBlob(access, id)).rejects.toThrow(/too large/i) }
  finally { vi.unstubAllGlobals() }
})
