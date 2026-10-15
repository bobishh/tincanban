import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import * as local from "../localDb"
import type { LocalStatePlan } from "../localDb"
import { RustyManagementRepository, type ManagementBinding, type ManagementUpdateRequest, type PortableManagementRecord } from "./rustyManagementRepository"
import type { RustyManagementCapability } from "./rustyManagementCapability"

afterEach(() => { resetIdentityStorageForTest(); vi.restoreAllMocks() })

async function fixture() {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const serviceKey = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const serviceId = await sha256Base64Url(serviceKey)
  const binding: ManagementBinding = { origin: "https://rusty.example", servicePublicKey: toBase64Url(serviceKey), resourceKind: "scope", resourceId: "scope-1" }
  const owner = profile.identity.personId
  const repository = new RustyManagementRepository(owner)
  const authorization = await signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "rusty-management-policy-update" as const, version: 1 as const, serviceId, origin: binding.origin,
    personId: owner, deviceId: profile.device.deviceId, resourceKind: binding.resourceKind, resourceId: binding.resourceId,
    expectedRevision: 0, operations: ["management.update", "scope.policy"], revokedDeviceIds: [],
    requestId: "policy-request", issuedAt: Date.now(), expiresAt: Date.now() + 120_000,
  }, profile.device.deviceId)
  const request: ManagementUpdateRequest = { version: 1, identity: profile.identity, deviceId: profile.device.deviceId,
    certificates: [profile.certificate], authorization }
  const authorizationHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(authorization)))
  const capability = (overrides: Partial<RustyManagementCapability> = {}) => signEnvelope(service.privateKey, {
    kind: "rusty-scope-management-capability" as const, version: 1 as const, serviceId, origin: binding.origin, personId: owner,
    resourceKind: binding.resourceKind, resourceId: binding.resourceId, revision: 1, operations: authorization.payload.operations,
    revokedDeviceIds: [], requestId: authorization.payload.requestId, authorizationHash, issuedAt: Date.now(), ...overrides,
  }, serviceId, "RUSTY/2")
  return { profile, owner, binding, repository, request, capability }
}

it("Given a policy request saved before sending, When the process restarts, Then exact signed bytes remain pending and are excluded from portable state", async () => {
  const f = await fixture()
  await f.repository.prepare(f.binding, f.request)
  const reopened = new RustyManagementRepository(f.owner)
  expect((await reopened.read(f.binding))?.pending).toEqual(f.request)
  expect(await reopened.export()).toEqual([])
  const completed = await f.capability()
  await reopened.observe(f.binding, completed)
  expect((await reopened.read(f.binding))?.pending).toBeUndefined()
  expect(await reopened.export()).toEqual([{ binding: f.binding, capability: completed }])
})

it("Given observed authority and revocations, When old evidence or removal arrives, Then preserve the highest verified revision and cumulative revocations", async () => {
  const f = await fixture()
  await f.repository.observe(f.binding, await f.capability({ revision: 2, revokedDeviceIds: [f.profile.device.deviceId] }))
  await expect(f.repository.observe(f.binding, await f.capability())).rejects.toThrow(/rollback/i)
  await expect(f.repository.observe(f.binding, await f.capability({ revision: 3 }))).rejects.toThrow(/revocation/i)
  expect((await f.repository.read(f.binding))?.capability?.payload.revision).toBe(2)
})

it("Given two different signed policies at one revision or a different service pin, When imported, Then reject instead of choosing a winner", async () => {
  const f = await fixture()
  await f.repository.observe(f.binding, await f.capability())
  await expect(f.repository.observe(f.binding, await f.capability({ operations: ["management.update"] }))).rejects.toThrow(/conflict/i)
  const other = { ...f.binding, servicePublicKey: f.profile.device.publicKey }
  await expect(f.repository.read(other)).rejects.toThrow(/pin/i)
})

it("Given an uncertain pending request, When newer unrelated policy arrives or a second request is prepared, Then retain original intent", async () => {
  const f = await fixture()
  await f.repository.prepare(f.binding, f.request)
  await f.repository.observe(f.binding, await f.capability({ revision: 2, requestId: "other-request" }))
  expect((await f.repository.read(f.binding))?.pending).toEqual(f.request)
  const changed = structuredClone(f.request)
  changed.authorization.payload.requestId = "replacement"
  changed.authorization = await signEnvelope(f.profile.privateKeys.devicePrivateKey, changed.authorization.payload, changed.deviceId)
  await expect(f.repository.prepare(f.binding, changed)).rejects.toThrow(/pending/i)
})

it("Given a failed local transaction, When observing the confirmed response, Then retain pending intent and old authority for recovery", async () => {
  const f = await fixture()
  await f.repository.prepare(f.binding, f.request)
  vi.spyOn(local, "updateLocal").mockRejectedValueOnce(new Error("transaction aborted"))
  await expect(f.repository.observe(f.binding, await f.capability())).rejects.toThrow("transaction aborted")
  expect((await f.repository.read(f.binding))?.pending).toEqual(f.request)
  expect((await f.repository.read(f.binding))?.capability).toBeUndefined()
})

it("Given simultaneous imports from two tabs, When both commit, Then retain both resources without lost updates", async () => {
  const f = await fixture()
  const second = { ...f.binding, resourceId: "scope-2" }
  await Promise.all([f.repository.observe(f.binding, await f.capability()),
    new RustyManagementRepository(f.owner).observe(second, await f.capability({ resourceId: second.resourceId }))])
  expect(await f.repository.export()).toHaveLength(2)
})

it("Given a private capability bundle containing old evidence and another resource, When imported, Then merge monotonically in one recoverable transaction", async () => {
  const f = await fixture()
  await f.repository.observe(f.binding, await f.capability({ revision: 2 }))
  const second = { ...f.binding, resourceId: "scope-2" }
  const bundle = [{ binding: f.binding, capability: await f.capability() },
    { binding: second, capability: await f.capability({ resourceId: second.resourceId }) }]
  await f.repository.import(bundle)
  expect((await f.repository.read(f.binding))?.capability?.payload.revision).toBe(2)
  expect(await f.repository.export()).toHaveLength(2)
  const third = { ...f.binding, resourceId: "scope-3" }
  const invalid = await f.capability({ resourceId: "different-scope" })
  await expect(f.repository.import([{ binding: third, capability: invalid },
    { binding: f.binding, capability: await f.capability({ revision: 3 }) }])).rejects.toThrow()
  expect((await f.repository.read(f.binding))?.capability?.payload.revision).toBe(2)
  expect(await f.repository.read(third)).toBeUndefined()
})

it("Given an altered pending signature or unexpected private fields, When saving or reading, Then reject the entire record", async () => {
  const f = await fixture()
  const changed = structuredClone(f.request)
  changed.authorization.payload.operations = ["management.update"]
  await expect(f.repository.prepare(f.binding, changed)).rejects.toThrow(/signature/i)
  await f.repository.prepare(f.binding, f.request)
  const key = `tincanban.rusty-management.v1.${f.owner}`
  const saved = JSON.parse((await local.readLocal(key))!)
  saved.records[0].contentKey = "secret"
  await local.writeLocal(key, JSON.stringify(saved))
  await expect(f.repository.read(f.binding)).rejects.toThrow(/record/i)
})

it("Given otherwise valid public evidence with extra private metadata, When preparing a request, Then reject before persisting or exporting it", async () => {
  const f = await fixture()
  const identity = { ...f.request.identity, contentKey: "private-content-key" }
  await expect(f.repository.prepare(f.binding, { ...f.request, identity })).rejects.toThrow(/record|evidence/i)
  const certificate = { ...f.request.certificates[0], privateKeys: { devicePrivateKey: "secret" } }
  await expect(f.repository.prepare(f.binding, { ...f.request, certificates: [certificate] })).rejects.toThrow(/record|evidence/i)
  expect(await f.repository.read(f.binding)).toBeUndefined()
})

it("Given an incoming capability and unresolved request, When planning import, Then return a pure CAS plan preserving pending intent and authority monotonicity", async () => {
  const f = await fixture()
  await f.repository.prepare(f.binding, f.request)
  const key = `tincanban.rusty-management.v1.${f.owner}`
  const before = await local.readLocal(key)
  const capability = await f.capability({ revision: 2, requestId: "unrelated-request", revokedDeviceIds: [f.profile.device.deviceId] })
  const plan = await (f.repository as unknown as { planImport(values: PortableManagementRecord[]): Promise<LocalStatePlan> })
    .planImport([{ binding: f.binding, capability }])

  expect(plan.conditions).toEqual([{ key, value: before }])
  expect(plan.writes).toHaveLength(1)
  const plannedState = JSON.parse(plan.writes[0].value!)
  expect(plannedState.records[0].pending).toEqual(f.request)
  expect(plannedState.records[0].capability.payload.revision).toBe(2)
  expect(plannedState.records[0].capability.payload.revokedDeviceIds).toEqual([f.profile.device.deviceId])
  expect(await local.readLocal(key)).toBe(before)

  await local.writeLocal(key, "concurrent-writer")
  expect(await local.compareAndSwapLocal(plan)).toBe(false)
  expect(await local.readLocal(key)).toBe("concurrent-writer")
})

it("Given mutable bundle evidence, When verification awaits, Then plan from the initial caller snapshot", async () => {
  const f = await fixture()
  const capability = await f.capability()
  const values = [{ binding: structuredClone(f.binding), capability: structuredClone(capability) }]
  let entered!: () => void
  let resume!: () => void
  const reachedVerify = new Promise<void>(resolve => { entered = resolve })
  const continueVerify = new Promise<void>(resolve => { resume = resolve })
  const originalVerify = crypto.subtle.verify.bind(crypto.subtle)
  const verify = vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
    entered()
    await continueVerify
    return originalVerify(...args)
  })
  try {
    const pending = (f.repository as unknown as { planImport(values: PortableManagementRecord[]): Promise<LocalStatePlan> }).planImport(values)
    await reachedVerify
    values[0].binding.resourceId = "mutated-resource"
    values[0].capability.payload.resourceId = "mutated-resource"
    resume()
    const plan = await pending
    expect(plan.writes).toHaveLength(1)
    expect(JSON.parse(plan.writes[0].value!).records[0].binding.resourceId).toBe(f.binding.resourceId)
  } finally { verify.mockRestore(); resume() }
})

it("Given an invalid capability among valid imports, When planning, Then reject the whole plan without writing", async () => {
  const f = await fixture()
  const second = { ...f.binding, resourceId: "scope-2" }
  const valid = await f.capability()
  const invalid = await f.capability({ resourceId: second.resourceId })
  invalid.signature = "forged"
  const key = `tincanban.rusty-management.v1.${f.owner}`
  const before = await local.readLocal(key)
  await expect((f.repository as unknown as { planImport(values: PortableManagementRecord[]): Promise<LocalStatePlan> })
    .planImport([{ binding: f.binding, capability: valid }, { binding: second, capability: invalid }])).rejects.toThrow()
  expect(await local.readLocal(key)).toBe(before)
})
