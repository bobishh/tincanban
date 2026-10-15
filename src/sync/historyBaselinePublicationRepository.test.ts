import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { canonicalizeJson, sha256Base64Url } from "@meta-uber/mesh-identity"
import { encodeBlindBytes } from "./blindEnvelope"
import type { BlindReplicaConfig } from "./blindReplication"
import type { WireHistoryBaseline } from "./historyBaselineReceiver"

beforeAll(() => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  vi.stubGlobal("IDBKeyRange", IDBKeyRange)
})

async function fixture(workspaceId: string) {
  const { BrowserMeshStore } = await import("@meta-uber/mesh-browser-store")
  const scan = vi.spyOn(BrowserMeshStore.prototype, "scan")
  const { publishWorkspaceHistoryRecord, readCurrentWorkspaceHistoryPublication, readPublishedHistoryBaseline } =
    await import("./historyBaselinePublicationRepository")
  const digest = "A".repeat(43), keyBytes = new Uint8Array(32).fill(7), nextKeyBytes = new Uint8Array(32).fill(8)
  const contentKey = encodeBlindBytes(keyBytes), nextContentKey = encodeBlindBytes(nextKeyBytes)
  const keyDigest = await sha256Base64Url(keyBytes)
  const scopeId = "scope-history", servicePublicKey = digest, origin = "https://rusty.example"
  const payload: Record<string, unknown> = { kind: "workspace-history-baseline", version: 1, workspaceId, baselineId: "",
    previousBaselineId: null, historyEpoch: 1, storage: { authority: { scopeId, servicePublicKey, policyRevision: 1 }, keyEpoch: 1, keyDigest } }
  delete payload.baselineId
  payload.baselineId = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(payload)))
  const signedJson = encodeBlindBytes(new TextEncoder().encode(canonicalizeJson({ payload, signerKeyId: digest, signature: "A".repeat(86) })))
  const context = { workspaceId, historyEpoch: 1, indexId: "basis-document" }
  const wire: WireHistoryBaseline = { version: 1, signedJson, basis: {
    context,
    reference: { kind: "workspace-history-bytes", version: 1,
      root: { objectId: digest, height: 0, count: 1, first: "0000000000000000", last: "0000000000000000" }, byteLength: 4, partCount: 1 },
    locatorRoot: { kind: "workspace-history-locator-root", version: 1,
      context: { ...context, indexId: "archive-locators" },
      root: { objectId: digest, ciphertextId: digest, height: 0, count: 1,
        first: digest, last: digest } },
    coverage: { payload: { kind: "blind-archive-coverage-aggregate-receipt", version: 1, serviceId: digest,
      scopeId, policyRevision: 1, requestId: "coverage-request-0001", archiveRootId: digest, height: 1,
      objectCount: 1, firstObjectId: digest, lastObjectId: digest, setDigest: digest, rootCovered: true },
      signerKeyId: digest, signature: "A".repeat(86) },
  } }
  const publicationId = "00000000-0000-4000-8000-000000000001"
  await publishWorkspaceHistoryRecord({ workspaceId, publicationId, wire, preparations: [{
    transitionId: publicationId, personId: "person", workspaceId, historyEpoch: 1, sourceRevision: "source",
    authorityRevision: "authority", privateBinding: "binding", previousBaselineId: null,
    storage: { origin, scopeId, policyRevision: 1, servicePublicKey, keyEpoch: 1, keyDigest },
  }] }, () => undefined)
  const currentConfig: BlindReplicaConfig = { origin, scopeId, servicePublicKey, readToken: "read-token", writeToken: "write-token", policyRevision: 1, keyEpoch: 1, contentKey,
    workspaceId, cursor: 0, lastUploaded: "" } as const
  const rotatedConfig: BlindReplicaConfig = { ...currentConfig, policyRevision: 2, keyEpoch: 2, contentKey: nextContentKey,
    historicalContentKeys: { "1": contentKey } }
  return { scan, readCurrentWorkspaceHistoryPublication, readPublishedHistoryBaseline, currentConfig, rotatedConfig, workspaceId }
}

describe("published history head lookup", () => {
  it("uses the durable current pointer on steady reads instead of rescanning and rehashing the publication chain", async () => {
    const f = await fixture("history-head-noop")
    f.scan.mockClear()
    await expect(f.readCurrentWorkspaceHistoryPublication(f.workspaceId, () => undefined)).resolves.toMatchObject({ publicationId: "00000000-0000-4000-8000-000000000001" })
    await expect(f.readCurrentWorkspaceHistoryPublication(f.workspaceId, () => undefined)).resolves.toMatchObject({ publicationId: "00000000-0000-4000-8000-000000000001" })
    expect(f.scan).not.toHaveBeenCalled()
  })

  it("keeps the original publication readable after same-scope credential rotation when its old key remains retained", async () => {
    const f = await fixture("history-head-rotation")
    await expect(f.readPublishedHistoryBaseline(f.workspaceId, f.currentConfig, () => undefined)).resolves.toMatchObject({ baselineId: expect.any(String) })
    await expect(f.readPublishedHistoryBaseline(f.workspaceId, f.rotatedConfig, () => undefined)).resolves.toMatchObject({ baselineId: expect.any(String) })
  })
})

it("Given a covered candidate before storage CAS, when retaining it, then keep prior publication current until exact checkpoint acknowledgement", async () => {
  const f = await fixture(`deferred-${crypto.randomUUID()}`)
  const repository = await import("./historyBaselinePublicationRepository")
  const original = (await f.readCurrentWorkspaceHistoryPublication(f.workspaceId, () => {}))!
  const envelope = JSON.parse(new TextDecoder().decode((await import("./blindEnvelope")).decodeBlindBytes(original.wire.signedJson))) as { payload: Record<string, unknown> }
  const previousBaselineId = envelope.payload.baselineId as string
  envelope.payload.previousBaselineId = previousBaselineId; envelope.payload.historyEpoch = 2; delete envelope.payload.baselineId
  envelope.payload.baselineId = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(envelope.payload)))
  const wire = structuredClone(original.wire)
  wire.signedJson = encodeBlindBytes(new TextEncoder().encode(canonicalizeJson(envelope)))
  wire.basis.context.historyEpoch = 2; wire.basis.locatorRoot.context.historyEpoch = 2
  const publicationId = crypto.randomUUID()
  const candidate = { workspaceId: f.workspaceId, publicationId, wire, preparations: original.preparations.map(value => ({ ...value,
    transitionId: publicationId, historyEpoch: 2, previousBaselineId })) }
  await repository.retainPreparedHistoryPublication(candidate, () => {})
  expect((await f.readCurrentWorkspaceHistoryPublication(f.workspaceId, () => {}))?.publicationId).toBe(original.publicationId)
  expect((await repository.readPreparedHistoryPublication(f.workspaceId, publicationId, () => {}))?.wire).toEqual(wire)
  await repository.commitPreparedHistoryPublication(f.workspaceId, publicationId, () => {})
  expect((await f.readCurrentWorkspaceHistoryPublication(f.workspaceId, () => {}))?.publicationId).toBe(publicationId)
})
