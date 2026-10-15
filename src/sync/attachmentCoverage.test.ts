import { afterEach, describe, expect, it, vi } from "vitest"
import { BLOB_CHUNK_BYTES, createBlobDescriptor } from "@meta-uber/mesh-blob"
import { blindHash, blindObjectId, canonicalBlindJson, type BlindAccess } from "./blindClient"
import { encodeBlindBytes } from "./blindEnvelope"
import { sealAttachment, type AttachmentScope } from "./attachmentCodec"
import { confirmRustyAttachmentCoverage } from "./attachmentCoverage"

afterEach(() => vi.unstubAllGlobals())

async function fixture() {
  const signingKey = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", signingKey.publicKey))
  const serviceId = await blindHash(rawKey)
  const access: BlindAccess = { origin: "https://rusty.example.test", scopeId: "private-scope", servicePublicKey: encodeBlindBytes(rawKey),
    readToken: "read-private-token", writeToken: "unused-write-token", policyRevision: 5 }
  const scope: AttachmentScope = { workspaceId: "workspace-one", scopeId: access.scopeId, keyEpoch: 3,
    contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))) }
  const bytes = new Uint8Array(BLOB_CHUNK_BYTES + 1).fill(47)
  const descriptor = await createBlobDescriptor(bytes, "large attachment.bin", "application/octet-stream")
  const sealed = await sealAttachment(scope, descriptor, bytes, "transfer-one")
  const signCoverage = async (objects: Array<{ objectId: string; keyEpoch: number }>, requestId: string,
    patch: Record<string, unknown> = {}) => {
    const payload = { kind: "blind-blob-coverage-receipt" as const, version: 1 as const, serviceId,
      scopeId: access.scopeId, policyRevision: access.policyRevision, requestId, objects, ...patch }
    return { payload, signerKeyId: serviceId, signature: encodeBlindBytes(new Uint8Array(await crypto.subtle.sign("Ed25519",
      signingKey.privateKey, new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)))) }
  }
  return { access, scope, descriptor, bytes, locator: sealed.locator, manifest: sealed.manifest, chunks: sealed.chunks,
    signCoverage }
}

function coverageRequest(body: unknown) {
  const parsed = body as { version: number; requestId: string; objects: Array<{ objectId: string; keyEpoch: number }> }
  return parsed
}

describe("cold attachment coverage adapter", () => {
  it("Given a cold locator, when confirming coverage, then fetch only the authenticated manifest and request every part", async () => {
    const f = await fixture()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith(`/blobs/${f.locator.manifestId}`)) {
        expect(init?.method).toBeUndefined()
        expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${f.access.readToken}`)
        return Response.json(f.manifest)
      }
      expect(url).toBe(`${f.access.origin}/v2/scopes/${f.access.scopeId}/blob-coverage`)
      expect(init?.method).toBe("POST")
      const request = coverageRequest(JSON.parse(String(init?.body)))
      expect(request.version).toBe(1)
      const expected = [{ objectId: f.locator.manifestId, keyEpoch: f.scope.keyEpoch },
        ...await Promise.all(f.chunks.map(async chunk => ({ objectId: await blindObjectId(chunk), keyEpoch: f.scope.keyEpoch })))]
      expect(request.objects).toEqual(expected.sort((left, right) => left.objectId < right.objectId ? -1 : 1))
      const objects = request.objects
      return Response.json(await f.signCoverage(objects, request.requestId))
    })
    vi.stubGlobal("fetch", fetch)
    const guard = vi.fn(async () => {})
    const descriptorWithPeerTicket = { ...f.descriptor, ticket: "peer-only-secret" }
    const result = await confirmRustyAttachmentCoverage(f.scope, f.access, descriptorWithPeerTicket, f.locator, guard)
    expect(result.payload.objects).toHaveLength(3)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(fetch.mock.calls[1]?.[1]?.body)).not.toContain("peer-only-secret")
    expect(guard).toHaveBeenCalled()
  })

  it("Given a retained epoch-three attachment and active epoch four, when confirming coverage, then bind every object to manifest epoch three", async () => {
    const f = await fixture()
    const rotatedScope: AttachmentScope = { ...f.scope, keyEpoch: 4, contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))),
      historicalContentKeys: { "3": f.scope.contentKey } }
    let requested: Array<{ objectId: string; keyEpoch: number }> = []
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith(`/blobs/${f.locator.manifestId}`)) return Response.json(f.manifest)
      const request = coverageRequest(JSON.parse(String(init?.body)))
      requested = request.objects
      return Response.json(await f.signCoverage(request.objects, request.requestId))
    })
    vi.stubGlobal("fetch", fetch)

    await confirmRustyAttachmentCoverage(rotatedScope, f.access, f.descriptor, f.locator, async () => {})

    const expected = [{ objectId: f.locator.manifestId, keyEpoch: f.manifest.keyEpoch },
      ...await Promise.all(f.chunks.map(async chunk => ({ objectId: await blindObjectId(chunk), keyEpoch: f.manifest.keyEpoch })))]
    expect(requested).toEqual(expected.sort((left, right) => left.objectId < right.objectId ? -1 : 1))
  })

  it("Given caller mutation during manifest transfer, when coverage completes, then keep captured scope and locator", async () => {
    const f = await fixture()
    const scope = structuredClone(f.scope), descriptor = structuredClone(f.descriptor), locator = structuredClone(f.locator)
    let release!: () => void
    const pendingRead = new Promise<void>(resolve => { release = resolve })
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(`/blobs/${f.locator.manifestId}`)) {
        await pendingRead
        return Response.json(f.manifest)
      }
      const request = coverageRequest(JSON.parse(String(init?.body)))
      return Response.json(await f.signCoverage(request.objects, request.requestId))
    })
    vi.stubGlobal("fetch", fetch)
    const operation = confirmRustyAttachmentCoverage(scope, f.access, descriptor, locator, async () => {})
    scope.scopeId = "other-scope"
    descriptor.blobId = "A".repeat(43)
    locator.manifestId = "B".repeat(43)
    release()
    await expect(operation).resolves.toMatchObject({ payload: { scopeId: f.access.scopeId } })
  })

  it("Given a wrong manifest, scope or descriptor, when confirming coverage, then fail before coverage POST", async () => {
    const f = await fixture()
    const other = await sealAttachment({ ...f.scope, workspaceId: "other-workspace" }, f.descriptor, f.bytes, "other-transfer")
    const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith(`/blobs/${f.locator.manifestId}`)
      ? Response.json(other.manifest) : Response.json({}))
    vi.stubGlobal("fetch", fetch)
    await expect(confirmRustyAttachmentCoverage(f.scope, f.access, f.descriptor, f.locator, async () => {})).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockClear()
    await expect(confirmRustyAttachmentCoverage(f.scope, { ...f.access, scopeId: "other-scope" }, f.descriptor,
      f.locator, async () => {})).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    await expect(confirmRustyAttachmentCoverage(f.scope, f.access, { ...f.descriptor, size: f.descriptor.size + 1 },
      f.locator, async () => {})).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("Given unavailable manifest or coverage endpoint, when confirming, then preserve network failure and do not claim coverage", async () => {
    const f = await fixture()
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "missing_blob", message: "Unavailable" }, { status: 404 })))
    await expect(confirmRustyAttachmentCoverage(f.scope, f.access, f.descriptor, f.locator, async () => {}))
      .rejects.toMatchObject({ status: 404, code: "missing_blob" })
    let count = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (++count === 1) return Response.json(f.manifest)
      return Response.json({ message: "Policy denied" }, { status: 403 })
    }))
    await expect(confirmRustyAttachmentCoverage(f.scope, f.access, f.descriptor, f.locator, async () => {}))
      .rejects.toMatchObject({ status: 403 })
  })

  it("Given identity changes during async coverage, when a receipt arrives, then do not return it as confirmation", async () => {
    const f = await fixture()
    let checks = 0
    const guard = vi.fn(async () => { if (++checks === 4) throw new Error("identity changed") })
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(`/blobs/${f.locator.manifestId}`)) return Response.json(f.manifest)
      const request = coverageRequest(JSON.parse(String(init?.body)))
      return Response.json(await f.signCoverage(request.objects, request.requestId))
    })
    vi.stubGlobal("fetch", fetch)
    await expect(confirmRustyAttachmentCoverage(f.scope, f.access, f.descriptor, f.locator, guard)).rejects.toThrow("identity changed")
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
