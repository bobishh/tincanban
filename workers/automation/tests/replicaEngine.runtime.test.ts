import { describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import automergeWasm from "@automerge/automerge/automerge.wasm"
import { profileFromIdentitySeedForDevice, signEnvelope } from "../../../vendor/meta-mesh/packages/mesh-identity/src/index"
import { createWorkspaceDoc } from "../../../src/test/boardFixture"
import { createAutomationWorkspaceGrant } from "../../../src/domain/proofs"
import * as identity from "../../../src/domain/identity"
import { blindHash, blindObjectId, canonicalBlindJson, type BlindReceipt } from "../../../src/sync/blindClient"
import { decodeBlindBytes, encodeBlindBytes, type BlindObject } from "../../../src/sync/blindEnvelope"
import { AutomationReplica, type AutomationActivationPacket, type ReplicaTransport } from "../src/replica"

await Automerge.initializeWasm(automergeWasm as unknown as Uint8Array)

async function fixture() {
  const owner = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(27), "Owner", new Uint8Array(32).fill(28))
  const automation = await profileFromIdentitySeedForDevice(new Uint8Array(32).fill(29), "Automation", new Uint8Array(32).fill(30))
  const doc = Automerge.from(createWorkspaceDoc("engine-contract-workspace", "Pipeline", owner.identity.personId, "job-search"), {
    actor: [...decodeBlindBytes(owner.device.deviceId)].map(byte => byte.toString(16).padStart(2, "0")).join(""),
  })
  const board = Object.values(doc.entities).find(value => "kind" in value && value.kind === "board")
  if (!board || !("kind" in board) || board.kind !== "board") throw new Error("Fixture board missing")
  const bindings = {
    boardId: board.id,
    columns: { lead: board.preset!.bindings["status.lead"]!, interview: board.preset!.bindings["status.interview"]!,
      rejected: board.preset!.bindings["status.rejected"]! },
    fieldIds: { company: board.preset!.bindings["field.company"]!, role: board.preset!.bindings["field.role"]!,
      notes: board.preset!.bindings["field.notes"]!, sourceText: board.preset!.bindings["field.sourceText"]! },
  }
  const ownerAuthority = { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }
  const authority = { genesisOwner: ownerAuthority, genesisEpoch: 1, currentOwner: ownerAuthority, currentEpoch: 1,
    ownershipTransfers: [], successionClaims: [], revocations: [], deviceRevocations: [], departures: [] }
  const proof = await signEnvelope(owner.privateKeys.devicePrivateKey, {
    kind: "workspace-changes" as const, version: 1 as const, workspaceId: doc.id,
    hashes: Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change).hash),
    personId: owner.identity.personId, deviceId: owner.device.deviceId,
  }, owner.device.deviceId)
  const authorization = { version: 1 as const, records: [{ signed: proof, publicKey: owner.identity.publicKey,
    certificates: [owner.certificate], ownerPublicKey: owner.identity.publicKey, ownerCertificates: [owner.certificate] }], authority }
  const grant = await createAutomationWorkspaceGrant(owner, doc.id, automation.identity.personId, {
    version: 1, boardId: board.id, columns: bindings.columns, fieldIds: Object.values(bindings.fieldIds), expiresAt: Date.now() + 60 * 60_000,
  })
  const service = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const servicePublicKey = encodeBlindBytes(publicKey)
  const serviceId = await blindHash(publicKey)
  const key = crypto.getRandomValues(new Uint8Array(32))
  const blind = { origin: "https://rusty.example.test", scopeId: "opaque-scope", servicePublicKey, readToken: "read", writeToken: "write",
    policyRevision: 1, workspaceId: doc.id, keyEpoch: 1, contentKey: encodeBlindBytes(key), cursor: 0, lastUploaded: "" }
  const persisted: string[] = []
  const receipts = new Map<string, BlindReceipt>()
  let sequence = 0
  let loseNextReceipt = false
  const transport: ReplicaTransport = {
    inventory: async (_access, cursor) => ({ objects: [], cursor, hasMore: false }),
    download: async () => { throw new Error("No remote objects expected") },
    upload: async (access, object, requestId) => {
      if (!requestId) throw new Error("Replica engine must supply stable request ID")
      const prior = receipts.get(requestId)
      if (prior) return prior
      const payload = { kind: "blind-storage-receipt" as const, version: 2 as const, serviceId, scopeId: access.scopeId,
        keyEpoch: object.keyEpoch, objectId: await blindObjectId(object), sequence: ++sequence,
        policyRevision: access.policyRevision, requestId }
      const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", service.privateKey,
        new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)))
      const receipt = { payload, signerKeyId: serviceId, signature: encodeBlindBytes(signature) }
      receipts.set(requestId, receipt)
      if (loseNextReceipt) { loseNextReceipt = false; throw new Error("durable receipt response lost") }
      return receipt
    },
  }
  const packet: AutomationActivationPacket = { version: 1, workspaceId: doc.id, blind, grant, bindings,
    initial: { document: encodeBlindBytes(Automerge.save(doc)), authorization, chat: null },
    persist: async value => { persisted.push(value) }, transport }
  Automerge.free(doc)
  return { owner, automation, packet, persisted, receipts,
    loseNextReceipt: () => { loseNextReceipt = true },
    get uploadCount() { return sequence } }
}

describe("AutomationReplica shared engine contract in workerd", () => {
  it("Given a signed item change, when storage confirms it, then the host observes only a verified receipt and the authored hash", async () => {
    const data = await fixture();
    const verified = vi.fn(async () => {});
    data.packet.transport!.receiptVerified = verified;
    const replica = await AutomationReplica.activate(data.packet, data.automation);
    await replica.createLead("receipt-observation", { company: "Receipt proof", role: "Engineer" }, {});
    await replica.sync();
    expect(verified).toHaveBeenCalled();
    expect(replica.appliedForRuntime("receipt-observation")?.changeHash).toMatch(/^[a-f0-9]{64}$/);
    const reject = await fixture();
    const invalidObserved = vi.fn(async () => {});
    const upload = reject.packet.transport!.upload;
    reject.packet.transport!.upload = async (...args) => ({ ...await upload(...args), signature: "invalid" });
    reject.packet.transport!.receiptVerified = invalidObserved;
    const invalid = await AutomationReplica.activate(reject.packet, reject.automation);
    await invalid.createLead("invalid-receipt", { company: "Receipt proof", role: "Engineer" }, {});
    await expect(invalid.sync()).rejects.toThrow();
    expect(invalidObserved).not.toHaveBeenCalled();
  });

  it("Given caller-owned profile keys change during actor signing, when intake runs, then the captured Worker identity still signs its own transaction", async () => {
    const data = await fixture()
    const replica = await AutomationReplica.activate(data.packet, data.automation)
    const persisted = data.persisted.length
    const original = crypto.subtle.sign.bind(crypto.subtle)
    let changed = false
    const sign = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const result = await original(...args)
      if (new TextDecoder().decode(args[2] as Uint8Array).includes('"actor-binding"')) {
        changed = true
        data.automation.privateKeys.devicePrivateKey = data.owner.privateKeys.devicePrivateKey
      }
      return result
    })
    try {
      await expect(replica.createLead("key-race", { company: "Example", role: "Engineer" }, {}))
        .resolves.toMatchObject({ duplicate: false })
      expect(changed).toBe(true)
      const state = JSON.parse(replica.serialize()) as { authorizations: Array<{ signed: identity.SignedEnvelope<{ kind: string }> }> }
      const authored = state.authorizations.find(record => record.signed.signerKeyId === data.automation.device.deviceId)
      expect(authored).toBeDefined()
      expect(await identity.verifyEnvelope(authored!.signed, data.automation.device.publicKey)).toBe(true)
      expect(await identity.verifyEnvelope(authored!.signed, data.owner.device.publicKey)).toBe(false)
      expect(data.persisted).toHaveLength(persisted + 1)
      expect(data.uploadCount).toBe(0)
    } finally { sign.mockRestore() }
  })

  it("Given the execution grant expires during actor signing, when intake runs, then preserve durable state and emit no upload", async () => {
    const data = await fixture()
    const replica = await AutomationReplica.activate(data.packet, data.automation)
    const before = replica.serialize()
    const persisted = data.persisted.length
    const original = crypto.subtle.sign.bind(crypto.subtle)
    const clock = vi.spyOn(Date, "now")
    const sign = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => {
      const result = await original(...args)
      if (new TextDecoder().decode(args[2] as Uint8Array).includes('"actor-binding"')) {
        clock.mockReturnValue(data.packet.grant.payload.automation!.expiresAt + 1)
      }
      return result
    })
    try {
      await expect(replica.createLead("expiry-race", { company: "Example", role: "Engineer" }, {})).rejects.toThrow(/expired/i)
      expect(replica.serialize()).toBe(before)
      expect(data.persisted).toHaveLength(persisted)
      expect(data.uploadCount).toBe(0)
    } finally { sign.mockRestore(); clock.mockRestore() }
  })

  it("Given an acknowledged upload, when four unchanged syncs poll it, then no historical document or proof payload is canonicalized or hashed, while grant expiry still rejects", async () => {
    const data = await fixture()
    const replica = await AutomationReplica.activate(data.packet, data.automation)
    await replica.sync()
    expect(data.uploadCount).toBe(1)

    const canonicalize = vi.spyOn(identity, "canonicalizeJson")
    const digest = vi.spyOn(crypto.subtle, "digest")
    try {
      for (let index = 0; index < 4; index++) await replica.sync()
      const serializedDocument = JSON.parse(replica.serialize()).rawDocument as string
      expect(canonicalize.mock.calls.some(([value]) => JSON.stringify(value).includes(serializedDocument))).toBe(false)
      expect(digest).not.toHaveBeenCalled()
      expect(data.uploadCount).toBe(1)

      vi.useFakeTimers()
      vi.setSystemTime(data.packet.grant.payload.automation!.expiresAt + 1)
      await expect(replica.sync()).rejects.toThrow(/expired/i)
    } finally {
      canonicalize.mockRestore()
      digest.mockRestore()
      vi.useRealTimers()
    }
  })

  it("Given acknowledged durable state restored into a fresh replica, when its first sync is unchanged, then it does not hash historical snapshot payload", async () => {
    const data = await fixture()
    const replica = await AutomationReplica.activate(data.packet, data.automation)
    await replica.sync()
    const restored = await AutomationReplica.restore(replica.serialize(), data.automation, async () => {}, data.packet.transport)
    const serializedDocument = JSON.parse(restored.serialize()).rawDocument as string
    const canonicalize = vi.spyOn(identity, "canonicalizeJson")
    const digest = vi.spyOn(crypto.subtle, "digest")
    try {
      await restored.sync()
      expect(canonicalize.mock.calls.some(([value]) => JSON.stringify(value).includes(serializedDocument))).toBe(false)
      expect(digest).not.toHaveBeenCalled()
      expect(data.uploadCount).toBe(1)
    } finally { canonicalize.mockRestore(); digest.mockRestore() }
  })

  it("Given encrypted upload reached storage but its response was lost, when replica restarts, then pending bytes and request ID are retried exactly", async () => {
    const data = await fixture()
    data.loseNextReceipt()
    const first = await AutomationReplica.activate(data.packet, data.automation)
    await expect(first.sync()).rejects.toThrow("durable receipt response lost")
    const interrupted = JSON.parse(data.persisted.at(-1)!)
    expect(interrupted.pending).toBeDefined()
    const pendingObject: BlindObject = interrupted.pending.object
    const pendingRequestId: string = interrupted.pending.requestId
    const calls: Array<{ object: BlindObject; requestId?: string }> = []
    const originalUpload = data.packet.transport!.upload
    const spyTransport: ReplicaTransport = { ...data.packet.transport!, upload: async (access, object, requestId) => {
      calls.push({ object: structuredClone(object), requestId })
      return originalUpload(access, object, requestId)
    } }
    const restored = await AutomationReplica.restore(data.persisted.at(-1)!, data.automation, async value => { data.persisted.push(value) }, spyTransport)

    await restored.sync()

    expect(calls[0]).toEqual({ object: pendingObject, requestId: pendingRequestId })
    expect(calls[0]?.object).toEqual(calls.at(-1)?.object)
    expect(calls[0]?.requestId).toBe(calls.at(-1)?.requestId)
    expect(JSON.parse(data.persisted.at(-1)!).pending).toBeUndefined()
  })

  it("Given an older encrypted upload is pending when local content changes, when sync retries, then old bytes finish first and new content uploads on next sync", async () => {
    const data = await fixture()
    data.loseNextReceipt()
    const replica = await AutomationReplica.activate(data.packet, data.automation)
    await expect(replica.sync()).rejects.toThrow("durable receipt response lost")
    const before = JSON.parse(data.persisted.at(-1)!)
    const firstObject: BlindObject = before.pending.object
    const firstRequestId: string = before.pending.requestId
    const uploadCalls: Array<{ object: BlindObject; requestId?: string }> = []
    const originalUpload = data.packet.transport!.upload
    const transport: ReplicaTransport = { ...data.packet.transport!, upload: async (access, object, requestId) => {
      uploadCalls.push({ object: structuredClone(object), requestId })
      return originalUpload(access, object, requestId)
    } }
    const restarted = await AutomationReplica.restore(data.persisted.at(-1)!, data.automation, async value => { data.persisted.push(value) }, transport)
    await restarted.createLead("new-after-pending", { company: "Example GmbH", role: "Engineer" }, {})

    await restarted.sync()
    expect(uploadCalls[0]).toEqual({ object: firstObject, requestId: firstRequestId })
    expect(uploadCalls).toHaveLength(1)
    await restarted.sync()

    expect(uploadCalls).toHaveLength(2)
    expect(uploadCalls[1]?.object).not.toEqual(firstObject)
    expect(uploadCalls[1]?.requestId).not.toBe(firstRequestId)
    expect(JSON.parse(data.persisted.at(-1)!).pending).toBeUndefined()
  })
})
