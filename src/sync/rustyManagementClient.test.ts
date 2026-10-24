import { bootstrapConfirmedIdentityFixture as bootstrapIdentity } from "./identityAuthority.testSupport"
import { afterEach, expect, it, vi } from "vitest"
import { canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url, verifyEnvelope } from "../domain/identity"
import { readRustyManagementStatus, retryRustyManagementUpdate, updateRustyManagementPolicy } from "./rustyManagementClient"
import { RustyManagementRepository, type ManagementBinding, type ManagementUpdateRequest } from "./rustyManagementRepository"
import type { RustyManagementStatusResponse, ManagementStatusAuthorization } from "./rustyManagementStatus"
import type { SignedEnvelope } from "../domain/identity"
import type { RustyManagementCapability } from "./rustyManagementCapability"

afterEach(() => { vi.unstubAllGlobals(); resetIdentityStorageForTest(); vi.restoreAllMocks() })
async function fixture() {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const key = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const serviceId = await sha256Base64Url(key)
  const binding: ManagementBinding = { origin: "https://rusty.example", servicePublicKey: toBase64Url(key), resourceKind: "scope", resourceId: "scope-1" }
  const repository = new RustyManagementRepository(profile.identity.personId)
  let capability: SignedEnvelope<RustyManagementCapability> | null = null
  const hash = (value: unknown) => sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
  const status = async (auth: SignedEnvelope<ManagementStatusAuthorization>, selected = capability): Promise<RustyManagementStatusResponse> => ({
    capability: selected, migrationPending: false, receipt: await signEnvelope(service.privateKey, {
      kind: "rusty-management-policy-status-receipt", version: 1, serviceId, origin: binding.origin,
      personId: profile.identity.personId, deviceId: profile.device.deviceId, resourceKind: "scope", resourceId: binding.resourceId,
      requestId: auth.payload.requestId, authorizationHash: await hash(auth), capabilityHash: selected ? await hash(selected) : null,
      revision: selected?.payload.revision ?? 0, migrationPending: false, issuedAt: Date.now(),
    }, serviceId, "RUSTY/2"),
  })
  const approve = async (request: ManagementUpdateRequest) => {
    const a = request.authorization.payload
    capability = await signEnvelope(service.privateKey, { kind: "rusty-scope-management-capability", version: 1,
      serviceId, origin: binding.origin, personId: profile.identity.personId, resourceKind: "scope", resourceId: binding.resourceId,
      revision: a.expectedRevision + 1, operations: a.operations, revokedDeviceIds: a.revokedDeviceIds,
      requestId: a.requestId, authorizationHash: await hash(request.authorization), issuedAt: Date.now() }, serviceId, "RUSTY/2")
    return capability
  }
  return { profile, service, binding, repository, status, approve }
}

it("Given an owner reading private management status, When no policy exists, Then sign exact resource without transferring storage credentials or silently migrating", async () => {
  const f = await fixture()
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(`${f.binding.origin}/v2/management/scope/scope-1/status`)
    expect(init.method).toBe("POST")
    const body = JSON.parse(String(init.body))
    expect(await verifyEnvelope(body.authorization, f.profile.device.publicKey)).toBe(true)
    expect(body.certificates).toEqual([f.profile.certificate])
    expect(body.authorization.payload).toMatchObject({ personId: f.profile.identity.personId, resourceId: f.binding.resourceId })
    expect(Object.keys(body).sort()).toEqual(["authorization", "certificates", "deviceId", "identity", "version"])
    return Response.json(await f.status(body.authorization))
  })
  vi.stubGlobal("fetch", fetch)
  expect(await readRustyManagementStatus(f.binding, f.profile)).toMatchObject({ capability: null, migrationPending: false })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await f.repository.export()).toEqual([])
})

it("Given a committed server update with a lost response, When browser restarts and retries, Then resend exact persisted body and clear only after verified confirmation", async () => {
  const f = await fixture()
  let first = true
  const bodies: string[] = []
  let confirmed: SignedEnvelope<RustyManagementCapability> | undefined
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body))
    const request = JSON.parse(String(init.body))
    expect((await f.repository.read(f.binding))?.pending).toEqual(request)
    confirmed ??= await f.approve(request)
    if (first) { first = false; throw new Error("connection lost after commit") }
    return Response.json({ capability: confirmed })
  }))
  await expect(updateRustyManagementPolicy(f.binding, f.profile, {
    operations: ["management.update", "scope.policy"], revokedDeviceIds: [],
  })).rejects.toThrow("connection lost")
  expect((await f.repository.read(f.binding))?.pending).toBeDefined()
  const afterDeadline = Date.now() + 130_000
  vi.spyOn(Date, "now").mockReturnValue(afterDeadline)
  await retryRustyManagementUpdate(f.binding, f.profile)
  expect(bodies[1]).toBe(bodies[0])
  expect((await f.repository.read(f.binding))?.pending).toBeUndefined()
  expect((await f.repository.read(f.binding))?.capability?.payload.revision).toBe(1)
})

it("Given lost update confirmation, When a fresh signed status confirms the exact intent, Then recover without sending the update again", async () => {
  const f = await fixture()
  let updates = 0
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    if (url.endsWith("/status")) return Response.json(await f.status(body.authorization))
    updates++
    await f.approve(body)
    throw new Error("reply lost")
  }))
  await expect(updateRustyManagementPolicy(f.binding, f.profile, { operations: ["management.update"], revokedDeviceIds: [] })).rejects.toThrow("reply lost")
  expect((await f.repository.read(f.binding))?.pending).toBeDefined()
  expect(await readRustyManagementStatus(f.binding, f.profile)).toMatchObject({ revision: 1 })
  expect((await f.repository.read(f.binding))?.pending).toBeUndefined()
  expect(updates).toBe(1)
})

it("Given a response signed for different intent, When updating, Then retain pending request instead of acknowledging completion", async () => {
  const f = await fixture()
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const capability = await f.approve(JSON.parse(String(init.body)))
    capability.payload.requestId = "other-request"
    const forgedBinding = await signEnvelope(f.service.privateKey, capability.payload, capability.signerKeyId, "RUSTY/2")
    return Response.json({ capability: forgedBinding })
  }))
  await expect(updateRustyManagementPolicy(f.binding, f.profile, { operations: ["management.update"], revokedDeviceIds: [] })).rejects.toThrow(/request|intent/i)
  expect((await f.repository.read(f.binding))?.pending).toBeDefined()
})

it("Given wrong signing key or an identity switch, When reading or retrying, Then send no request under stale authority", async () => {
  const f = await fixture()
  const other = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const fetch = vi.fn(async () => { throw new Error("Unexpected request") })
  vi.stubGlobal("fetch", fetch)
  await expect(readRustyManagementStatus(f.binding, { ...f.profile, privateKeys: { devicePrivateKey: other.privateKey } })).rejects.toThrow()
  resetIdentityStorageForTest()
  await bootstrapIdentity("Other")
  await expect(readRustyManagementStatus(f.binding, f.profile)).rejects.toThrow(/stale|identity/i)
  expect(fetch).not.toHaveBeenCalled()
})

it("Given a higher persisted revision, When status reports no policy, Then reject rollback without erasing authority", async () => {
  const f = await fixture()
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => Response.json({ capability: await f.approve(JSON.parse(String(init.body))) })))
  await updateRustyManagementPolicy(f.binding, f.profile, { operations: ["management.update"], revokedDeviceIds: [] })
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const auth = JSON.parse(String(init.body)).authorization
    return Response.json(await f.status(auth, null))
  }))
  await expect(readRustyManagementStatus(f.binding, f.profile)).rejects.toThrow(/rollback|missing/i)
  expect((await f.repository.read(f.binding))?.capability?.payload.revision).toBe(1)
})
