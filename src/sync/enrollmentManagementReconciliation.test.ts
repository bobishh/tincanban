import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import * as local from "../localDb"
import { RustyManagementRepository, type ManagementBinding } from "./rustyManagementRepository"
import type { RustyManagementCapability } from "./rustyManagementCapability"
import type { ManagementStatusAuthorization, RustyManagementStatusResponse } from "./rustyManagementStatus"
import { enrollmentManagementConflictResolver } from "./enrollmentManagementReconciliation"

afterEach(() => { resetIdentityStorageForTest(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function fixture() {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const serviceId = await sha256Base64Url(publicKey)
  const binding: ManagementBinding = { origin: "https://rusty.example", servicePublicKey: toBase64Url(publicKey),
    resourceKind: "person", resourceId: profile.identity.personId }
  const repository = new RustyManagementRepository(profile.identity.personId)
  const capability = (requestId: string, overrides: Partial<RustyManagementCapability> = {}) => signEnvelope(service.privateKey, {
    kind: "rusty-person-management-capability", version: 1, serviceId, origin: binding.origin, personId: profile.identity.personId,
    resourceKind: "person", resourceId: binding.resourceId, revision: 2, operations: ["management.update", "resource.create"],
    revokedDeviceIds: [], requestId, authorizationHash: "A".repeat(43), issuedAt: Date.now(), ...overrides,
  } satisfies RustyManagementCapability, serviceId, "RUSTY/2")
  const old = await capability("before-reset", { revokedDeviceIds: [profile.device.deviceId] })
  const current = await capability("after-reset")
  await repository.observe(binding, old)
  const hash = (value: unknown) => sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
  const status = async (authorization: { payload: ManagementStatusAuthorization }, cap = current): Promise<RustyManagementStatusResponse> => ({
    capability: cap, migrationPending: false, receipt: await signEnvelope(service.privateKey, {
      kind: "rusty-management-policy-status-receipt", version: 1, serviceId, origin: binding.origin,
      personId: profile.identity.personId, deviceId: profile.device.deviceId, resourceKind: "person", resourceId: binding.resourceId,
      requestId: authorization.payload.requestId, authorizationHash: await hash(authorization), capabilityHash: await hash(cap),
      revision: cap.payload.revision, migrationPending: false, issuedAt: Date.now(),
    }, serviceId, "RUSTY/2"),
  })
  const fetch = vi.fn(async (_url: string, init: RequestInit) => Response.json(await status(JSON.parse(String(init.body)).authorization)))
  vi.stubGlobal("fetch", fetch)
  const resolve = enrollmentManagementConflictResolver({ profile, certificates: [profile.certificate] }, profile, () => {})
  const incoming = [{ binding, capability: current }]
  return { profile, binding, repository, capability, current, old, status, fetch, resolve, incoming }
}

it("Given a returning device retained a conflicting pre-reset policy, when explicit enrollment reads current signed Rusty status, then atomically import the confirmed policy and reject stale peer replay", async () => {
  const f = await fixture()
  const key = `tincanban.rusty-management.v1.${f.profile.identity.personId}`
  const before = await local.readLocal(key)
  const plan = await f.repository.planImport(f.incoming, f.resolve)
  expect(await local.readLocal(key)).toBe(before)
  expect(f.fetch).toHaveBeenCalledOnce()
  expect(await local.compareAndSwapLocal(plan)).toBe(true)
  expect((await f.repository.read(f.binding))?.capability).toEqual(f.current)
  await f.repository.import([{ binding: f.binding, capability: f.old }])
  expect((await f.repository.read(f.binding))?.capability).toEqual(f.current)
})

it("Given conflicting portable policies, when ordinary replication imports without enrollment approval, then retain the conflict check", async () => {
  const f = await fixture()
  await expect(f.repository.import(f.incoming)).rejects.toThrow("Management policy revision conflict")
  expect(f.fetch).not.toHaveBeenCalled()
  expect((await f.repository.read(f.binding))?.capability).toEqual(f.old)
})

it.each(["offline", "wrong nonce", "still revoked", "rollback"])("Given enrollment encounters %s during reconciliation, when planning activation, then preserve all local authority", async failure => {
  const f = await fixture()
  const before = await f.repository.export()
  f.fetch.mockImplementation(async (_url, init) => {
    if (failure === "offline") throw new Error("offline")
    const authorization = JSON.parse(String(init.body)).authorization
    if (failure === "wrong nonce") authorization.payload.requestId = "another-request"
    const cap = failure === "still revoked" ? f.old : failure === "rollback"
      ? await f.capability("rolled-back", { revision: 1 }) : f.current
    return Response.json(await f.status(authorization, cap))
  })
  await expect(f.repository.planImport(f.incoming, f.resolve)).rejects.toThrow()
  expect(await f.repository.export()).toEqual(before)
})

it("Given unchanged management policy, when enrolling offline, then need no server reconciliation", async () => {
  const f = await fixture()
  await f.repository.planImport([{ binding: f.binding, capability: f.old }], f.resolve)
  expect(f.fetch).not.toHaveBeenCalled()
})

it("Given another resource has an unresolved management request, when enrollment reconciles a conflict, then preserve the saved request", async () => {
  const f = await fixture()
  const binding = { ...f.binding, resourceKind: "scope" as const, resourceId: "another-scope" }
  const issuedAt = Date.now()
  const authorization = await signEnvelope(f.profile.privateKeys.devicePrivateKey, {
    kind: "rusty-management-policy-update" as const, version: 1 as const, serviceId: f.current.payload.serviceId,
    origin: binding.origin, personId: f.profile.identity.personId, deviceId: f.profile.device.deviceId,
    resourceKind: binding.resourceKind, resourceId: binding.resourceId, expectedRevision: 0,
    operations: ["management.update", "scope.policy"], revokedDeviceIds: [], requestId: "pending-request", issuedAt, expiresAt: issuedAt + 120_000,
  }, f.profile.device.deviceId)
  const request = { version: 1 as const, identity: f.profile.identity, deviceId: f.profile.device.deviceId,
    certificates: [f.profile.certificate], authorization }
  await f.repository.prepare(binding, request)
  const plan = await f.repository.planImport(f.incoming, f.resolve)
  expect(await local.compareAndSwapLocal(plan)).toBe(true)
  expect((await f.repository.read(binding))?.pending).toEqual(request)
})

it("Given enrollment is cancelled, when conflicting policy needs reconciliation, then send no status request", async () => {
  const f = await fixture()
  const resolve = enrollmentManagementConflictResolver({ profile: f.profile, certificates: [f.profile.certificate] }, f.profile,
    () => { throw new Error("enrollment cancelled") })
  await expect(f.repository.planImport(f.incoming, resolve)).rejects.toThrow("enrollment cancelled")
  expect(f.fetch).not.toHaveBeenCalled()
})
