import { afterEach, expect, it, vi } from "vitest"
import { deliverPublicBoard } from "./publicDelivery"
import { canonicalizeJson, sha256Base64Url, signEnvelope, toBase64Url } from "@meta-uber/mesh-identity"

afterEach(() => vi.unstubAllGlobals())

it("Given a private or withdrawn board, when a durable writer retries, then no projection or credentials are delivered", async () => {
  const buildProjection = vi.fn()
  const fetch = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(null, { status: 404 }))
  vi.stubGlobal("fetch", fetch)
  expect(await deliverPublicBoard({ origin: "https://rusty.example", boardId: "board", workspaceId: "workspace",
    identity: { personId: "person", publicKey: "key", displayName: "Writer" }, deviceId: "device", certificates: [],
    grant: { payload: { kind: "workspace-grant", version: 1, grantId: "grant", workspaceId: "workspace", personId: "person", role: "editor" }, signerKeyId: "owner", signature: "signed" },
    sourceHeads: ["a".repeat(64)], ensureCurrent: () => {}, ensureSourceCovers: () => {}, sign: vi.fn(), buildProjection })).toBeNull()
  expect(buildProjection).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty("body")
})

it.each([false, true])("Given an admitted editor with forged challenge=%s, when delivering without the owner, then bind frontier, generation, revision and staged files", async forged => {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const serviceKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
  const serviceId = await sha256Base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
  const hash = (value: unknown) => sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
  const current = { kind: "tincanban-public-board" as const, version: 1 as const, board: { id: "board", title: "Before" }, columns: [], cards: [], fields: [], files: [], discussions: [] }
  const sourceHeads = ["a".repeat(64)]
  const origin = "https://rusty.example"
  let writes = 0
  const signed = (payload: Record<string, unknown> & { kind: string }) => signEnvelope(pair.privateKey, payload, serviceId, "RUSTY/2")
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith("mesh-lighthouse")) return Response.json({ publicOrigin: origin, service: { serviceId, publicKey: serviceKey }, capabilities: { publicBoardPublication: { deliveryVersion: 1 } } })
    if (String(url).endsWith("challenges")) {
      const request = JSON.parse(String(init?.body))
      expect(request.sourceHeads).toEqual(sourceHeads)
      return Response.json({ challenge: await signed({ kind: "rusty-publication-challenge", version: 1,
        challengeId: "A".repeat(43), nonce: "B".repeat(43), serviceId, publicOrigin: origin, boardId: "board",
        personId: "person", deviceId: "device", deviceKeyId: "device", expectedRevision: 1,
        projectionHash: await hash(current), issuedAt: Date.now(), expiresAt: Date.now() + 60000, withdrawn: false,
        deliveryGeneration: 2, deliveryGrantId: "grant", sourceHeadsHash: forged ? "C".repeat(43) : await hash(sourceHeads), currentSourceHeads: sourceHeads }) })
    }
    if (init?.method === "PUT") {
      writes++
      const body = JSON.parse(String(init.body)), p = body.authorization.payload
      expect(p).toMatchObject({ deliveryGeneration: 2, deliveryGrantId: "grant", sourceHeadsHash: await hash(sourceHeads), expectedRevision: 1 })
      return Response.json(await signed({ kind: String(url).endsWith("files") ? "rusty-public-asset-receipt" : "rusty-publication-receipt",
        version: 1, serviceId, boardId: "board", challengeId: p.challengeId, authorizationHash: await hash(body.authorization),
        controllerPersonId: "person", revision: 2, action: "update", withdrawn: false, projectionHash: p.projectionHash,
        ...(body.sha256 ? { sha256: body.sha256, byteLength: body.byteLength } : {}) }))
    }
    return Response.json({ boardId: "board", revision: 1, projection: current, hash: await hash(current) })
  }))
  const operation = deliverPublicBoard({ origin, workspaceId: "workspace", boardId: "board", identity: { personId: "person", publicKey: serviceKey, displayName: "Editor" },
    deviceId: "device", certificates: [], sourceHeads, ensureCurrent: () => {}, ensureSourceCovers: heads => { expect(heads).toEqual(sourceHeads) },
    grant: { payload: { kind: "workspace-grant", version: 1, grantId: "grant", workspaceId: "workspace", personId: "person", role: "editor" }, signerKeyId: "owner", signature: "signed" },
    sign: payload => signEnvelope(pair.privateKey, payload, "device"),
    buildProjection: async (_current, stage) => { const bytes = new Uint8Array([1, 2, 3]); await stage({ bytes, sha256: await sha256Base64Url(bytes) }); return { ...current, board: { id: "board", title: "After" } } },
  })
  if (forged) { await expect(operation).rejects.toThrow(/challenge/); expect(writes).toBe(0) }
  else { await expect(operation).resolves.toMatchObject({ revision: 2 }); expect(writes).toBe(2) }
})

it("Given untrusted origin or empty source frontier, when writer queues delivery, then fail before any network call", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch)
  await expect(deliverPublicBoard({ origin: "https://rusty.example/other", boardId: "board" } as never)).rejects.toThrow(/origin|HTTPS/)
  await expect(deliverPublicBoard({ origin: "https://rusty.example", boardId: "board", sourceHeads: [] } as never)).rejects.toThrow(/frontier/)
  expect(fetch).not.toHaveBeenCalled()
})
