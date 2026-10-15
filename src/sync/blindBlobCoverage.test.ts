import { afterEach, describe, expect, it, vi } from "vitest"
import { blindHash, canonicalBlindJson, type BlindAccess } from "./blindClient"
import { encodeBlindBytes } from "./blindEnvelope"
import { requestBlindBlobCoverage, verifyBlindBlobCoverageReceipt, type BlindBlobCoverageReceipt } from "./blindBlobCoverage"

const scopeId = "private-scope"
const requestId = "coverage-request-identifier-01"

afterEach(() => vi.unstubAllGlobals())

async function fixture() {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey))
  const access: BlindAccess = { origin: "https://rusty.example.test", scopeId, servicePublicKey: encodeBlindBytes(raw),
    readToken: "read-secret", writeToken: "write-secret", policyRevision: 7 }
  const serviceId = await blindHash(raw)
  const objects = [{ objectId: "B".repeat(43), keyEpoch: 2 }, { objectId: "A".repeat(43), keyEpoch: 1 }]
  const sorted = [...objects].sort((left, right) => left.objectId < right.objectId ? -1 : 1)
  const sign = async (payload: BlindBlobCoverageReceipt["payload"]): Promise<BlindBlobCoverageReceipt> => ({
    payload, signerKeyId: serviceId,
    signature: encodeBlindBytes(new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey,
      new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)))),
  })
  const receipt = async (patch: Partial<BlindBlobCoverageReceipt["payload"]> = {}) => sign({
    kind: "blind-blob-coverage-receipt", version: 1, serviceId, scopeId, policyRevision: access.policyRevision,
    requestId, objects: sorted, ...patch,
  })
  return { access, key, serviceId, objects, sorted, sign, receipt }
}

describe("Rusty encrypted blob coverage client", () => {
  it("Given encrypted-object IDs, when requesting coverage, then send sorted bounded IDs with the read token and verify the signed receipt", async () => {
    const f = await fixture()
    const receipt = await f.receipt()
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(`${f.access.origin}/v2/scopes/${scopeId}/blob-coverage`)
      expect(init?.method).toBe("POST")
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      const headers = new Headers(init?.headers)
      expect(headers.get("Authorization")).toBe(`Bearer ${f.access.readToken}`)
      expect(headers.get("Content-Type")).toBe("application/json")
      expect(headers.get("X-Rusty-Request-Id")).toBeNull()
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toEqual({ version: 1, requestId, objects: f.sorted })
      expect(JSON.stringify(body)).not.toMatch(/read-secret|write-secret|contentKey|privateKey/i)
      return Response.json(receipt)
    })
    vi.stubGlobal("fetch", fetch)
    await expect(requestBlindBlobCoverage(f.access, f.objects, requestId)).resolves.toEqual(receipt)
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(verifyBlindBlobCoverageReceipt(receipt, f.access, f.objects, requestId)).resolves.toBeUndefined()
  })

  it("Given mutable caller input, when hashing or sending waits, then retain the original object list", async () => {
    const f = await fixture()
    let release!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve })
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      await waiting
      expect(JSON.parse(String(init?.body))).toEqual({ version: 1, requestId, objects: f.sorted })
      return Response.json(await f.receipt())
    }))
    const mutable = structuredClone(f.objects)
    const pending = requestBlindBlobCoverage(f.access, mutable, requestId)
    mutable[0]!.objectId = "C".repeat(43)
    mutable.pop()
    release()
    await expect(pending).resolves.toBeDefined()
  })

  it("Given malformed or excessive IDs, when requesting coverage, then reject before network access", async () => {
    const f = await fixture()
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    for (const objects of [[], [{ objectId: "bad", keyEpoch: 1 }], [{ objectId: "A".repeat(43), keyEpoch: 0 }],
      [{ objectId: "A".repeat(43), keyEpoch: 1 }, { objectId: "A".repeat(43), keyEpoch: 1 }],
      Array.from({ length: 34 }, (_, index) => ({ objectId: index.toString().padStart(43, "A"), keyEpoch: 1 }))]) {
      await expect(requestBlindBlobCoverage(f.access, objects, requestId)).rejects.toThrow()
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it("Given substituted coverage or service signatures, when verifying, then reject every mismatch", async () => {
    const f = await fixture()
    const valid = await f.receipt()
    await expect(verifyBlindBlobCoverageReceipt(valid, f.access, f.objects, requestId)).resolves.toBeUndefined()
    for (const patch of [
      { scopeId: "other-scope" }, { policyRevision: 8 }, { requestId: "other-request-identifier-01" },
      { objects: [...f.sorted].reverse() }, { objects: [{ ...f.sorted[0]!, keyEpoch: 3 }, f.sorted[1]!] },
    ]) {
      await expect(verifyBlindBlobCoverageReceipt(await f.receipt(patch), f.access, f.objects, requestId)).rejects.toThrow()
    }
    await expect(verifyBlindBlobCoverageReceipt({ ...valid, payload: { ...valid.payload, extra: true } } as never,
      f.access, f.objects, requestId)).rejects.toThrow()
    await expect(verifyBlindBlobCoverageReceipt({ ...valid, signature: encodeBlindBytes(new Uint8Array(64)) },
      f.access, f.objects, requestId)).rejects.toThrow()
    const foreignKey = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair
    const foreignReceipt = await f.sign(valid.payload)
    const forged = { ...foreignReceipt, signature: encodeBlindBytes(new Uint8Array(await crypto.subtle.sign("Ed25519", foreignKey.privateKey,
      new TextEncoder().encode(`RUSTY/2/${foreignReceipt.payload.kind}\0${canonicalBlindJson(foreignReceipt.payload)}`)))) }
    await expect(verifyBlindBlobCoverageReceipt(forged, f.access, f.objects, requestId)).rejects.toThrow()
  })

  it("Given a failed or oversized response, when requesting coverage, then preserve status and enforce the response cap", async () => {
    const f = await fixture()
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "writer_upgrade_required", message: "Update Rusty" }, { status: 426 })))
    await expect(requestBlindBlobCoverage(f.access, f.objects, requestId)).rejects.toMatchObject({ status: 426, code: "writer_upgrade_required" })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`{"padding":"${"x".repeat(32 * 1024)}"}`)))
    await expect(requestBlindBlobCoverage(f.access, f.objects, requestId)).rejects.toThrow(/too large/i)
  })
})
