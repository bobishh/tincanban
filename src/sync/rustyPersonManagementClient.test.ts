import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import { RustyManagementRepository, type ManagementBinding, type ManagementUpdateRequest } from "./rustyManagementRepository"
import { resolveRustyManagementAuthority, updateRustyManagementPolicy } from "./rustyManagementClient"

afterEach(() => { vi.unstubAllGlobals(); resetIdentityStorageForTest() })

async function fixture(revoked: string[] = []) {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Person management")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const serviceId = await sha256Base64Url(raw)
  const binding: ManagementBinding = { origin: "https://rusty.example", servicePublicKey: toBase64Url(raw), resourceKind: "scope", resourceId: "new-scope" }
  const parentBinding: ManagementBinding = { ...binding, resourceKind: "person", resourceId: profile.identity.personId }
  const parent = await signEnvelope(service.privateKey, { kind: "rusty-person-management-capability" as const, version: 1 as const,
    serviceId, origin: binding.origin, personId: profile.identity.personId, resourceKind: "person" as const, resourceId: profile.identity.personId,
    revision: 1, operations: ["management.update", "resource.create"], revokedDeviceIds: revoked,
    requestId: "person-request", authorizationHash: "A".repeat(43), issuedAt: Date.now() }, serviceId, "RUSTY/2")
  const repository = new RustyManagementRepository(profile.identity.personId)
  await repository.observe(parentBinding, parent)
  const hash = (value: unknown) => sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
  return { profile, service, serviceId, binding, parentBinding, parent, repository, hash }
}

it("Given confirmed person authority, when an owner creates a scope policy, then send its exact capability with a signed parent revision and retain it in pending intent", async () => {
  const f = await fixture()
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as ManagementUpdateRequest
    expect(request.personManagementCapability).toEqual(f.parent)
    expect(request.authorization.payload.personManagementRevision).toBe(1)
    expect((await f.repository.read(f.binding))?.pending).toEqual(request)
    const a = request.authorization.payload
    return Response.json({ capability: await signEnvelope(f.service.privateKey, {
      kind: "rusty-scope-management-capability", version: 1, serviceId: f.serviceId, origin: f.binding.origin,
      personId: f.profile.identity.personId, resourceKind: "scope", resourceId: f.binding.resourceId, revision: 1,
      operations: a.operations, revokedDeviceIds: a.revokedDeviceIds, requestId: a.requestId,
      authorizationHash: await f.hash(request.authorization), issuedAt: a.issuedAt,
    }, f.serviceId, "RUSTY/2") })
  }))
  await updateRustyManagementPolicy(f.binding, f.profile, { operations: ["management.update", "scope.policy"], revokedDeviceIds: [] })
  expect((await f.repository.read(f.binding))?.pending).toBeUndefined()
})

it("Given the current person policy revokes the signer, then scope management stops before network delivery even with valid certificate ancestry", async () => {
  const f = await fixture()
  const revoked = await signEnvelope(f.service.privateKey, { ...f.parent.payload, revision: 2,
    requestId: "person-revocation", revokedDeviceIds: [f.profile.device.deviceId] }, f.serviceId, "RUSTY/2")
  await f.repository.observe(f.parentBinding, revoked)
  const fetch = vi.fn(async () => { throw new Error("unexpected network") })
  vi.stubGlobal("fetch", fetch)
  await expect(updateRustyManagementPolicy(f.binding, f.profile, { operations: ["management.update", "scope.policy"], revokedDeviceIds: [] }))
    .rejects.toThrow(/person|revoked|authorize/i)
  expect(fetch).not.toHaveBeenCalled()
  expect(await f.repository.read(f.binding)).toBeUndefined()
})

it("Given person authority changes while signing, then no stale creation request is delivered or persisted", async () => {
  const f = await fixture()
  let changed = false
  const fetch = vi.fn(async () => { throw new Error("unexpected network") })
  vi.stubGlobal("fetch", fetch)
  await expect(updateRustyManagementPolicy(f.binding, f.profile, { operations: ["management.update", "scope.policy"], revokedDeviceIds: [] }, {
    ensureCurrent: async () => {
      if (changed) return
      changed = true
      await f.repository.observe(f.parentBinding, await signEnvelope(f.service.privateKey, { ...f.parent.payload, revision: 2,
        requestId: "creation-disabled", operations: ["management.update"] }, f.serviceId, "RUSTY/2"))
    },
  })).rejects.toThrow(/person|operation|authorize|stale/i)
  expect(fetch).not.toHaveBeenCalled()
  expect(await f.repository.read(f.binding)).toBeUndefined()
})

it("Given confirmed person policy but no resource policy yet, when discovery loses management support, then reject instead of returning controller fallback", async () => {
  const f = await fixture()
  const fetch = vi.fn(async () => { throw new Error("unexpected network") })
  vi.stubGlobal("fetch", fetch)
  await expect(resolveRustyManagementAuthority(f.binding, f.profile, "scope.policy", false)).rejects.toThrow(/upgrade/i)
  expect(fetch).not.toHaveBeenCalled()
})

it("Given a new scope and person creation rights, when a publication operation is mistakenly requested, then reject before creating any policy", async () => {
  const f = await fixture()
  const fetch = vi.fn(async () => { throw new Error("unexpected network") })
  vi.stubGlobal("fetch", fetch)
  await expect(resolveRustyManagementAuthority(f.binding, f.profile, "publication.publish", true)).rejects.toThrow(/operation|rights/i)
  expect(fetch).not.toHaveBeenCalled()
  expect(await f.repository.read(f.binding)).toBeUndefined()
})
