import { expect, it, vi } from "vitest"
import { canonicalizeJson, fromBase64Url, publicKeyId, sha256Base64Url, signEnvelope, toBase64Url } from "../../../vendor/meta-mesh/packages/mesh-identity/src/index"
import { openArchiveObject, sealArchiveObject, type ArchiveEncryptionBinding } from "../../../vendor/meta-mesh/packages/mesh-replication/src/historyArchiveCrypto"
import { createArchiveRemote } from "../../../vendor/meta-mesh/packages/mesh-replication/src/historyArchiveRemote"
import { archiveCoverageBranch, verifyArchiveCoverageChild } from "../../../vendor/meta-mesh/packages/mesh-replication/src/historyArchiveCoverage"
import { confirmArchiveCoverageSet, verifyCompleteArchiveCoverage } from "../../../vendor/meta-mesh/packages/mesh-replication/src/historyArchiveCoverageSet"
import fixture from "../../../vendor/meta-mesh/packages/mesh-replication/fixtures/history-archive-crypto-v1.json"

it("Given the shared native/browser archive vector in Workerd, when the same SDK seals, uploads and reads it, then authenticate exact bytes and distinct signed storage/batch receipts", async () => {
  const scope = { ...fixture.scope, key: fromBase64Url(fixture.key) }
  const binding = fixture.binding as ArchiveEncryptionBinding
  const original = fromBase64Url(fixture.plaintext)
  expect(await openArchiveObject(scope, binding, fixture.ciphertextId, { ...fixture.object, version: 1 })).toEqual(original)
  const sealed = await sealArchiveObject(scope, binding, original)
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair
  const servicePublicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
  const serviceId = await publicKeyId(servicePublicKey)
  const access = { origin: "https://rusty.example", scopeId: scope.scopeId, policyRevision: 4,
    readToken: "private-read-token", writeToken: "private-write-token", servicePublicKey }
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = String(input)
    expect(init?.redirect).toBe("manual")
    const token = new Headers(init?.headers).get("Authorization")
    if (init?.method === "GET") {
      expect(token).toBe(`Bearer ${access.readToken}`)
      expect(url).toContain(`/archives/${sealed.ciphertextId}`)
      return Response.json(sealed.object)
    }
    const common = { version: 1, serviceId, scopeId: access.scopeId, policyRevision: 4 }
    if (init?.method === "PUT") {
      expect(token).toBe(`Bearer ${access.writeToken}`)
      const object = JSON.parse(String(init.body))
      expect(await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(object)))).toBe(sealed.ciphertextId)
      return Response.json(await signEnvelope(pair.privateKey, { ...common, kind: "blind-archive-storage-receipt",
        objectId: sealed.ciphertextId, keyEpoch: scope.keyEpoch,
        requestId: new Headers(init.headers).get("X-Rusty-Request-Id")! }, serviceId, "RUSTY/2"))
    }
    expect(token).toBe(`Bearer ${access.readToken}`)
    const request = JSON.parse(String(init?.body))
    if (url.endsWith("/aggregate")) {
      const summaries = []
      for (const child of request.children) summaries.push(await verifyArchiveCoverageChild(child, access, request.archiveRootId))
      return Response.json(await signEnvelope(pair.privateKey, { ...common, kind: "blind-archive-coverage-aggregate-receipt",
        requestId: request.requestId, archiveRootId: request.archiveRootId,
        ...await archiveCoverageBranch(request.archiveRootId, summaries) }, serviceId, "RUSTY/2"))
    }
    expect(url).toBe(`${access.origin}/v2/scopes/${access.scopeId}/archive-coverage`)
    return Response.json(await signEnvelope(pair.privateKey, { ...common, kind: "blind-archive-coverage-batch-receipt",
      requestId: request.requestId, objects: request.objects }, serviceId, "RUSTY/2"))
  })
  const remote = createArchiveRemote(access, { fetch: fetcher, ensureCurrent: () => {} })
  expect((await remote.upload(sealed.object, "archive-worker-request-0001")).payload.kind).toBe("blind-archive-storage-receipt")
  const read = await remote.download(sealed.ciphertextId)
  expect(await openArchiveObject(scope, binding, sealed.ciphertextId, read)).toEqual(original)
  expect((await remote.coverage([{ objectId: sealed.ciphertextId, keyEpoch: scope.keyEpoch }],
    "archive-worker-coverage-0001")).payload.kind).toBe("blind-archive-coverage-batch-receipt")
  const objects = [{ objectId: sealed.ciphertextId, keyEpoch: scope.keyEpoch }]
  const complete = await confirmArchiveCoverageSet(access, sealed.ciphertextId, "worker-transition-0001", objects,
    { ...remote, ensureCurrent: () => {} })
  expect(await verifyCompleteArchiveCoverage(complete, access, sealed.ciphertextId, objects))
    .toMatchObject({ objectCount: 1, height: 1, rootCovered: true })
})

it("Given a Worker authority generation changes during archive I/O, when a valid response arrives, then the shared SDK rejects completion", async () => {
  let current = true
  const remote = createArchiveRemote({ origin: "https://rusty.example", scopeId: fixture.scope.scopeId,
    policyRevision: 1, servicePublicKey: "A".repeat(43), readToken: "read", writeToken: "write" }, {
    ensureCurrent: () => { if (!current) throw new Error("Worker generation replaced") },
    fetch: vi.fn(async () => { current = false; return Response.json(fixture.object) }),
  })
  await expect(remote.download(fixture.ciphertextId)).rejects.toThrow("Worker generation replaced")
})
