import { readFile } from "node:fs/promises"
import { IDBFactory } from "fake-indexeddb"
import * as Automerge from "@automerge/automerge/slim"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import type { BlindReplicaConfig } from "./blindReplication"
import type { RustyScopeEnrollmentOptions } from "./rustyEnrollment"

async function modules() {
  const [crdt, identity, seeds, changes, peer, repository, local, index, scope, enrollment, client, writer, records, workers] = await Promise.all([
    import("../crdt"), import("../domain/identity"), import("../domain/seeds"), import("./changeAuthorization"),
    import("./peerStore"), import("./privateReplicaRepository"), import("../localDb"), import("./attachmentIndexRepository"),
    import("./attachmentIndexScope"), import("./rustyEnrollment"), import("./blindClient"), import("./workspaceReplicaWriter"), import("./meshRecords"),
    import("./workspaceReplicaWorkers"),
  ])
  return { ...crdt, ...identity, ...seeds, ...changes, ...peer, ...repository, ...local, ...index, ...scope, ...writer, ...records, enrollment, client, workers }
}
let runtime: Awaited<ReturnType<typeof modules>>
beforeAll(async () => {
  vi.stubGlobal("indexedDB", new IDBFactory())
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  runtime = await modules()
  await runtime.initializeAutomerge()
})
afterEach(() => { vi.restoreAllMocks(); runtime?.resetIdentityStorageForTest() })
afterAll(() => vi.unstubAllGlobals())

async function fixture() {
  const profile = await runtime.bootstrapIdentity("Writer owner")
  const seed = runtime.createWorkspaceDoc(crypto.randomUUID(), "Writer policy", profile.identity.personId, "blank")
  const doc = Automerge.from(seed)
  await runtime.recordGenesisAuthority(doc, profile)
  const token = "A".repeat(43)
  const serviceKey = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", serviceKey.publicKey))
  const servicePublicKey = runtime.toBase64Url(rawKey), serviceId = await runtime.sha256Base64Url(rawKey)
  const config: BlindReplicaConfig = { workspaceId: doc.id, origin: "https://rusty.example", scopeId: "scope-writer",
    contentKey: token, readToken: token, writeToken: token, servicePublicKey,
    policyRevision: 3, keyEpoch: 1, cursor: 0, lastUploaded: "" }
  await runtime.setReplicaPreference(profile.identity.personId, config)
  const [selected] = await runtime.getReplicaConfigurations(profile.identity.personId)
  const progress = await runtime.getPrivateReplicaProgress(profile.identity.personId, selected!)
  await runtime.persistPrivateReplicaState(profile.identity.personId, selected!, 0, { ...progress, generation: 1, cursor: 9,
    lastUploaded: token, uploadedRevision: "confirmed-content" })
  const app = { getCurrentProfile: () => profile, readWorkspaceDoc: async () => doc }
  const service = { origin: config.origin, servicePublicKey, serviceId, writerPolicy: { version: 1 as const, maximumWriterVersion: 2 as const } }
  const discovery = vi.spyOn(runtime.client, "discoverBlindKeeper").mockResolvedValue(service)
  const confirmScope = async (revision: number, options?: RustyScopeEnrollmentOptions) => {
    const receipt = await runtime.signEnvelope(serviceKey.privateKey, { kind: "rusty-scope-policy-receipt" as const, version: 1 as const,
      serviceId, scopeId: config.scopeId, personId: profile.identity.personId, revision, revoked: false,
      challengeId: "confirmed-scope", authorizationHash: token, minimumWriterVersion: 2 as const }, serviceId, "RUSTY/2")
    await options?.confirmed?.(receipt)
    return revision
  }
  const approval = vi.spyOn(runtime.enrollment, "approveRustyScope").mockImplementation(async (_access, _profile, _revoked, options) => confirmScope(4, options))
  const discoverWorkers = vi.spyOn(runtime.workers, "discoverWorkspaceReplicaWorkers").mockResolvedValue([])
  const refreshWorkers = vi.spyOn(runtime.workers, "refreshWorkspaceReplicaWorkers").mockResolvedValue(undefined)
  const owner = profile.identity.personId
  return { owner, profile, doc, app, config: (await runtime.getReplicaConfigurations(owner))[0]!, discovery, approval, service,
    confirmScope, discoverWorkers, refreshWorkers,
    revoke: async () => {
      const authority = await runtime.peerStore.getWorkspaceAuthority(doc.id)
      if (!authority) throw new Error("Missing genesis authority")
      const removal = await runtime.createWorkspaceDeviceRevocation(profile, doc.id, owner, profile.device.deviceId,
        Automerge.getHeads(doc), [profile.certificate])
      await runtime.peerStore.putWorkspaceAuthority({ ...authority, catalog: { ...authority.catalog as object, deviceRevocations: [removal] } })
    }, close: () => Automerge.free(doc) }
}

test("Given legacy file discovery and confirmed progress, when the owner upgrades a writer, then migrate discovery before signed enrollment and preserve acknowledgments", async () => {
  const f = await fixture()
  try {
    const locator = { version: 1 as const, blobId: `sha256:${"A".repeat(43)}`, transferId: "original-transfer", manifestId: "A".repeat(43) }
    const oldIndex = runtime.createAttachmentIndexRepository(runtime.privateReplicaBinding(f.owner, f.config), () => {})
    await oldIndex.merge([locator])
    f.approval.mockImplementation(async (access, _profile, revoked, options) => {
      expect(revoked).toBe(false)
      expect(access).toEqual(f.config)
      expect(options?.minimumWriterVersion).toBe(2)
      await (options as { ensureCurrent: () => Promise<void> }).ensureCurrent()
      const stable = runtime.createAttachmentIndexRepository(runtime.attachmentIndexBinding(f.owner, f.config), () => {})
      expect(await stable.read()).toEqual([locator])
      await expect(runtime.getPrivateReplicaProgress(f.owner, f.config)).rejects.toThrow(/upgrade.*pending/i)
      return f.confirmScope(4, options)
    })
    const next = await runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})
    expect(next).toMatchObject({ minimumWriterVersion: 2, policyRevision: 4, cursor: 9, lastUploaded: "A".repeat(43) })
    expect(await runtime.createWorkspaceAttachmentIndex(f.owner, next, () => {}).read()).toEqual([locator])
    expect(await oldIndex.read()).toEqual([locator])
    expect(await runtime.getPrivateReplicaProgress(f.owner, next)).toMatchObject({ cursor: 9, uploadedRevision: "confirmed-content" })
    expect(f.approval).toHaveBeenCalledTimes(1)
    await runtime.ensureWorkspaceReplicaWriter(f.app as never, next, () => {})
    expect(f.approval).toHaveBeenCalledTimes(1)
  } finally { f.close() }
})

test("Given a legacy local marker but an already-current signed floor-2 policy, when writer migration runs, then publish the marker at the same revision", async () => {
  const f = await fixture()
  try {
    f.approval.mockImplementation(async (_access, _profile, _revoked, options) => f.confirmScope(f.config.policyRevision, options))
    const next = await runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})
    expect(next).toMatchObject({ minimumWriterVersion: 2, policyRevision: f.config.policyRevision, cursor: 9,
      lastUploaded: "A".repeat(43) })
    expect(await runtime.getPrivateReplicaProgress(f.owner, next)).toMatchObject({ cursor: 9, uploadedRevision: "confirmed-content" })
  } finally { f.close() }
})

test("Given a writer upgrade finishes after a caller captured old access, when maintenance enters its lock, then adopt only the newer same-key repository revision", async () => {
  const f = await fixture()
  try {
    const current = { ...f.config, policyRevision: f.config.policyRevision + 1, minimumWriterVersion: 2 as const,
      cursor: 17, lastUploaded: "B".repeat(43) }
    await runtime.setReplicaPreference(f.owner, current)
    expect(await runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).toMatchObject({
      policyRevision: current.policyRevision, minimumWriterVersion: current.minimumWriterVersion,
      cursor: 9, lastUploaded: "A".repeat(43),
    })
    expect(f.approval).not.toHaveBeenCalled()
  } finally { f.close() }
})

test("Given the repository changed a stored write credential, when a stale writer request resumes, then reject instead of adopting it", async () => {
  const f = await fixture()
  try {
    const changed = { ...f.config, policyRevision: f.config.policyRevision + 1, writeToken: "B".repeat(43), minimumWriterVersion: 2 as const }
    await runtime.setReplicaPreference(f.owner, changed)
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow(/credential revision changed/i)
    expect(f.approval).not.toHaveBeenCalled()
  } finally { f.close() }
})

test("Given a lost enrollment response, when retrying after restart, then reuse the frozen source credentials and finish from a fresh monotonic receipt", async () => {
  const f = await fixture()
  try {
    f.approval.mockRejectedValueOnce(new Error("Reply lost after durable scope write"))
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow("Reply lost")
    const intent = await runtime.readReplicaWriterUpgrade(f.owner, f.config)
    expect(intent?.config).toEqual(f.config)
    const configs = await runtime.getReplicaConfigurations(f.owner)
    expect(configs[0]).not.toHaveProperty("minimumWriterVersion")
    f.approval.mockImplementation(async (_access, _profile, _revoked, options) => f.confirmScope(5, options))
    const next = await runtime.ensureWorkspaceReplicaWriter(f.app as never, configs[0]!, () => {})
    expect(next).toMatchObject({ policyRevision: 5, minimumWriterVersion: 2, cursor: 9 })
    expect(f.approval.mock.calls[0]![0]).toEqual(f.approval.mock.calls[1]![0])
    expect(await runtime.readReplicaWriterUpgrade(f.owner, next)).toBeUndefined()
  } finally { f.close() }
})

test("Given a device revoked while Rusty confirms policy, when the request returns, then keep the durable barrier without activating the reply", async () => {
  const f = await fixture()
  try {
    f.approval.mockImplementation(async () => { await f.revoke(); return 4 })
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow(/revok|permission|authority/i)
    expect(await runtime.readReplicaWriterUpgrade(f.owner, f.config)).toBeDefined()
    expect((await runtime.getReplicaConfigurations(f.owner))[0]).not.toHaveProperty("minimumWriterVersion")
    await expect(runtime.getPrivateReplicaProgress(f.owner, f.config)).rejects.toThrow(/upgrade.*pending/i)
  } finally { f.close() }
})

test("Given a legacy server or pending outbox, when scheduling compatibility, then retain normal replication without creating a policy intent", async () => {
  const f = await fixture()
  try {
    f.discovery.mockResolvedValue({ origin: f.config.origin, servicePublicKey: f.config.servicePublicKey, serviceId: f.service.serviceId })
    expect(await runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).toEqual(f.config)
    expect(await runtime.readReplicaWriterUpgrade(f.owner, f.config)).toBeUndefined()
    f.discovery.mockResolvedValue(f.service)
    const progress = await runtime.getPrivateReplicaProgress(f.owner, f.config)
    await runtime.persistPrivateReplicaState(f.owner, f.config, progress.generation, { ...progress, generation: progress.generation + 1,
      pending: { requestId: crypto.randomUUID(), hash: "A".repeat(43), bytes: 1,
        object: { version: 1, scopeId: f.config.scopeId, keyEpoch: 1, nonce: "A".repeat(16), ciphertext: "A".repeat(23) } } })
    expect(await runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).toEqual(f.config)
    expect(await runtime.readReplicaWriterUpgrade(f.owner, f.config)).toBeUndefined()
    expect(f.approval).not.toHaveBeenCalled()
  } finally { f.close() }
})

test("Given optional Worker discovery fails before any writer intent, when post-sync maintenance runs, then ordinary legacy replication remains successful", async () => {
  const f = await fixture()
  try {
    f.discoverWorkers.mockRejectedValueOnce(new Error("Module terminated"))
    await expect(runtime.maintainWorkspaceReplicaWriter(f.app as never, f.config, () => {}, async () => {})).resolves.toBeUndefined()
    expect(await runtime.readReplicaWriterUpgrade(f.owner, f.config)).toBeUndefined()
    expect(f.approval).not.toHaveBeenCalled()
    expect(f.refreshWorkers).not.toHaveBeenCalled()
  } finally { f.close() }
})

test("Given a retained writer transition and unavailable automation, when resuming storage policy, then activate only Rusty's verified receipt and retain automation maintenance without contacting it", async () => {
  const f = await fixture()
  try {
    f.approval.mockRejectedValueOnce(new Error("Lost Rusty reply"))
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow("Lost Rusty reply")
    f.discoverWorkers.mockClear().mockRejectedValue(new Error("Module terminated"))
    f.refreshWorkers.mockClear()
    const next = await runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {}, { storageOnly: true })
    expect(next).toMatchObject({ minimumWriterVersion: 2, policyRevision: 4, cursor: 9 })
    expect(f.discoverWorkers).not.toHaveBeenCalled()
    expect(f.refreshWorkers).not.toHaveBeenCalled()
    expect(await runtime.readReplicaWriterUpgrade(f.owner, next)).toMatchObject({ localActivated: true })
    const progress = await runtime.getPrivateReplicaProgress(f.owner, next)
    expect(progress).toMatchObject({ cursor: 9, uploadedRevision: "confirmed-content" })
    await runtime.persistPrivateReplicaState(f.owner, next, progress.generation, { ...progress,
      generation: progress.generation + 1, cursor: 10 })
    await runtime.maintainWorkspaceReplicaWriter(f.app as never, next, () => {}, async () => {})
    expect(await runtime.getPrivateReplicaProgress(f.owner, next)).toMatchObject({ cursor: 10 })
    expect(await runtime.readReplicaWriterUpgrade(f.owner, next)).toMatchObject({ localActivated: true })
    await expect(runtime.getPrivateReplicaProgress(f.owner, f.config)).rejects.toThrow(/revision changed/i)
  } finally { f.close() }
})

test("Given locally activated policy and new durable ciphertext, when automation eventually confirms, then clear only maintenance and preserve exact pending upload", async () => {
  const f = await fixture()
  try {
    await runtime.prepareReplicaWriterUpgrade(f.owner, f.config)
    const next = await runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {}, { storageOnly: true })
    const progress = await runtime.getPrivateReplicaProgress(f.owner, next)
    const pending = { requestId: crypto.randomUUID(), hash: "A".repeat(43), bytes: 1,
      object: { version: 1 as const, scopeId: next.scopeId, keyEpoch: 1, nonce: "A".repeat(16), ciphertext: "A".repeat(23) } }
    await runtime.persistPrivateReplicaState(f.owner, next, progress.generation,
      { ...progress, generation: progress.generation + 1, pending })
    const before = await runtime.getPrivateReplicaProgress(f.owner, next)
    await runtime.ensureWorkspaceReplicaWriter(f.app as never, next, () => {})
    expect(await runtime.readReplicaWriterUpgrade(f.owner, next)).toBeUndefined()
    expect(await runtime.getPrivateReplicaProgress(f.owner, next)).toEqual(before)
  } finally { f.close() }
})

test("Given an altered or mismatched Rusty receipt, when activating storage before automation maintenance, then preserve the frozen credentials and reject it", async () => {
  const f = await fixture()
  try {
    const original = await runtime.prepareReplicaWriterUpgrade(f.owner, f.config)
    let confirmed = original
    await f.confirmScope(4, { confirmed: async receipt => {
      confirmed = await runtime.confirmReplicaWriterUpgrade(f.owner, original, receipt)
    } })
    await expect(runtime.activateReplicaWriterUpgrade(f.owner,
      { ...confirmed, confirmed: { ...confirmed.confirmed!, signature: "A".repeat(86) } }, 4)).rejects.toThrow(/receipt/i)
    await expect(runtime.activateReplicaWriterUpgrade(f.owner, confirmed, 3)).rejects.toThrow(/exact.*revision/i)
    expect(await runtime.readReplicaWriterUpgrade(f.owner, f.config)).toEqual(confirmed)
    await expect(runtime.getPrivateReplicaProgress(f.owner, f.config)).rejects.toThrow(/upgrade.*pending/i)
  } finally { f.close() }
})

test("Given a durable writer intent, when post-sync maintenance sees it, then leave it for strict resolver resume", async () => {
  const f = await fixture()
  try {
    f.approval.mockRejectedValueOnce(new Error("Reply lost after durable policy write"))
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow("Reply lost")
    const pending = await runtime.readReplicaWriterUpgrade(f.owner, f.config)
    expect(pending).toBeDefined()
    await expect(runtime.maintainWorkspaceReplicaWriter(f.app as never, f.config, () => {}, async () => {})).resolves.toBeUndefined()
    f.discoverWorkers.mockRejectedValueOnce(new Error("Module terminated"))
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow("Module terminated")
    expect(await runtime.readReplicaWriterUpgrade(f.owner, f.config)).toEqual(pending)
    expect((await runtime.getReplicaConfigurations(f.owner))[0]).not.toHaveProperty("minimumWriterVersion")
  } finally { f.close() }
})

test("Given a replaced service pin, when preparing compatibility, then reject before freezing or enrolling storage", async () => {
  const f = await fixture()
  try {
    f.discovery.mockResolvedValue({ ...f.service, servicePublicKey: "B".repeat(42) + "A" })
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow(/pin/i)
    expect(await runtime.readReplicaWriterUpgrade(f.owner, f.config)).toBeUndefined()
    expect(f.approval).not.toHaveBeenCalled()
  } finally { f.close() }
})

test("Given a lost reply followed by another own device's policy update, when the scheduler sees floor 2, then resume and clear the outstanding local barrier", async () => {
  const f = await fixture()
  try {
    f.approval.mockRejectedValueOnce(new Error("Reply lost"))
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow("Reply lost")
    const preferences = await import("./privateReplicaPreferences")
    const wire = await runtime.exportPrivateReplicaState(f.owner)
    const incoming = preferences.portableReplicaState(preferences.changeReplicaPreference(
      { ...wire, actorId: "peer-confirmed-writer", progress: {}, migrated: true }, { ...f.config, policyRevision: 4, minimumWriterVersion: 2 }))
    await runtime.receivePrivateReplicaState(f.owner, incoming)
    const [current] = await runtime.getReplicaConfigurations(f.owner)
    f.approval.mockImplementation(async (_access, _profile, _revoked, options) => f.confirmScope(5, options))
    const result = await runtime.ensureWorkspaceReplicaWriter(f.app as never, current!, () => {})
    expect(result).toMatchObject({ policyRevision: 5, minimumWriterVersion: 2, cursor: 9 })
    expect(await runtime.readReplicaWriterUpgrade(f.owner, result)).toBeUndefined()
    expect(f.approval).toHaveBeenCalledTimes(2)
  } finally { f.close() }
})

test("Given a Worker refresh reply is lost after Rusty confirms policy, when the migration retries, then reuse the saved receipt while ordinary storage remains active", async () => {
  const f = await fixture()
  try {
    const worker = { origin: "https://automation.example", workspaceId: f.doc.id, definitionId: "intake",
      executorPersonId: "worker-person", integrationId: "existing-route" }
    f.discoverWorkers.mockResolvedValue([worker])
    f.refreshWorkers.mockRejectedValueOnce(new Error("Worker maintenance response lost"))
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow("Worker maintenance response lost")
    const pending = await runtime.readReplicaWriterUpgrade(f.owner, f.config)
    expect(pending?.workers).toEqual([worker])
    expect(pending?.confirmed?.payload.revision).toBe(4)
    expect((await runtime.getReplicaConfigurations(f.owner))[0]).toMatchObject({ minimumWriterVersion: 2, policyRevision: 4 })
    expect(pending?.localActivated).toBe(true)
    const updated = await runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})
    expect(updated).toMatchObject({ minimumWriterVersion: 2, policyRevision: 4, cursor: 9 })
    expect(f.approval).toHaveBeenCalledTimes(1)
    expect(f.refreshWorkers).toHaveBeenCalledTimes(2)
    expect(f.refreshWorkers.mock.calls[1]![2]).toEqual(pending!.confirmed)
  } finally { f.close() }
})

test("Given an existing Worker cannot refresh access, when preparing a scope upgrade, then stop before changing remote policy or freezing local replication", async () => {
  const f = await fixture()
  try {
    f.discoverWorkers.mockRejectedValueOnce(new Error("Worker upgrade required for storage maintenance"))
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow("Worker upgrade required")
    expect(f.approval).not.toHaveBeenCalled()
    expect(await runtime.readReplicaWriterUpgrade(f.owner, f.config)).toBeUndefined()
    expect(await runtime.getPrivateReplicaProgress(f.owner, f.config)).toMatchObject({ cursor: 9 })
  } finally { f.close() }
})

test("Given a second Worker appears during maintenance, when checking the cohort again, then retain both routes while the local writer stays active", async () => {
  const f = await fixture()
  try {
    const first = { origin: "https://automation.example", workspaceId: f.doc.id, definitionId: "first",
      executorPersonId: "first-worker", integrationId: "first-route" }
    const second = { ...first, definitionId: "second", executorPersonId: "second-worker", integrationId: "second-route" }
    f.discoverWorkers.mockResolvedValue([first, second]).mockResolvedValueOnce([first])
    f.refreshWorkers.mockImplementation(async (_profile, _config, receipt, workers, guard) => {
      await guard()
      expect((await runtime.readReplicaWriterUpgrade(f.owner, f.config))?.workers).toEqual(workers)
      expect((await runtime.getReplicaConfigurations(f.owner))[0]).toMatchObject({ minimumWriterVersion: 2, policyRevision: 4 })
      expect(receipt.payload.revision).toBe(4)
    })
    const updated = await runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})
    expect(updated).toMatchObject({ minimumWriterVersion: 2, policyRevision: 4 })
    expect(f.refreshWorkers.mock.calls.map(call => call[3])).toEqual([[first], [first, second]])
    expect(f.approval).toHaveBeenCalledTimes(1)
  } finally { f.close() }
})

test("Given a captured Worker disappears from the document and refresh fails, when retrying, then retain its route rather than silently skipping maintenance", async () => {
  const f = await fixture()
  try {
    const worker = { origin: "https://automation.example", workspaceId: f.doc.id, definitionId: "removed",
      executorPersonId: "worker-person", integrationId: "retained-route" }
    f.discoverWorkers.mockResolvedValue([]).mockResolvedValueOnce([worker])
    f.refreshWorkers.mockRejectedValueOnce(new Error("Worker unavailable"))
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow("Worker unavailable")
    const saved = await runtime.readReplicaWriterUpgrade(f.owner, f.config)
    expect(saved?.workers).toEqual([worker])
    const updated = await runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})
    expect(updated.minimumWriterVersion).toBe(2)
    expect(f.refreshWorkers.mock.calls[1]![3]).toEqual([worker])
    expect(f.approval).toHaveBeenCalledTimes(1)
  } finally { f.close() }
})

test("Given current device authority is revoked during Worker maintenance, when the response arrives, then stop maintenance and retain its confirmed journal without rolling back the earlier storage policy", async () => {
  const f = await fixture()
  try {
    f.refreshWorkers.mockImplementationOnce(async () => { await f.revoke() })
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow(/revok|permission|authority/i)
    expect((await runtime.readReplicaWriterUpgrade(f.owner, f.config))?.confirmed?.payload.revision).toBe(4)
    expect((await runtime.getReplicaConfigurations(f.owner))[0]).toMatchObject({ minimumWriterVersion: 2, policyRevision: 4 })
    await expect(runtime.getPrivateReplicaProgress(f.owner, f.config)).rejects.toThrow(/revision changed/i)
  } finally { f.close() }
})

test("Given new Workers keep arriving during maintenance, when the bounded rescan cannot stabilize, then preserve every captured route and resume them on the next pass", async () => {
  const f = await fixture()
  try {
    let count = 0
    f.discoverWorkers.mockImplementation(async () => Array.from({ length: ++count }, (_, index) => ({
      origin: "https://automation.example", workspaceId: f.doc.id, definitionId: `worker-${index}`,
      executorPersonId: `executor-${index}`, integrationId: `route-${index}`,
    })))
    await expect(runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})).rejects.toThrow(/kept changing/i)
    const pending = await runtime.readReplicaWriterUpgrade(f.owner, f.config)
    expect(pending?.workers).toHaveLength(5)
    expect(pending?.confirmed?.payload.revision).toBe(4)
    expect((await runtime.getReplicaConfigurations(f.owner))[0]).toMatchObject({ minimumWriterVersion: 2, policyRevision: 4 })
    f.discoverWorkers.mockResolvedValue([])
    const updated = await runtime.ensureWorkspaceReplicaWriter(f.app as never, f.config, () => {})
    expect(updated.minimumWriterVersion).toBe(2)
    expect(f.refreshWorkers.mock.calls.at(-1)![3]).toHaveLength(5)
    expect(f.approval).toHaveBeenCalledTimes(1)
  } finally { f.close() }
})
