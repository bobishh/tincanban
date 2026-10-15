import { afterEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import { ensureRustyPersonPolicy } from "./rustyManagementClient"
import { RustyManagementRepository, type ManagementUpdateRequest } from "./rustyManagementRepository"
import { RustyPermissionMigrationRequiredError } from "./rustyPermissionMigration"

afterEach(() => { vi.unstubAllGlobals(); resetIdentityStorageForTest() })

async function fixture() {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Pinned controller")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const serviceId = await sha256Base64Url(raw)
  const access = { origin: "https://rusty.example", servicePublicKey: toBase64Url(raw) }
  const binding = { ...access, resourceKind: "person" as const, resourceId: profile.identity.personId }
  const repository = new RustyManagementRepository(profile.identity.personId)
  const hash = (value: unknown) => sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
  const requests: { url: string; body: ManagementUpdateRequest }[] = []
  let capability: unknown = null
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as ManagementUpdateRequest
    requests.push({ url, body })
    const a = body.authorization.payload
    if (url.endsWith("/status")) {
      const revision = capability ? 1 : 0
      return Response.json({ capability, migrationPending: false, receipt: await signEnvelope(service.privateKey, {
        kind: "rusty-management-policy-status-receipt", version: 1, serviceId, origin: access.origin,
        personId: profile.identity.personId, deviceId: profile.device.deviceId, resourceKind: "person", resourceId: binding.resourceId,
        requestId: a.requestId, authorizationHash: await hash(body.authorization), capabilityHash: capability ? await hash(capability) : null,
        revision, migrationPending: false, issuedAt: Date.now(),
      }, serviceId, "RUSTY/2") })
    }
    capability = await signEnvelope(service.privateKey, { kind: "rusty-person-management-capability", version: 1,
      serviceId, origin: access.origin, personId: profile.identity.personId, resourceKind: "person", resourceId: binding.resourceId,
      revision: 1, operations: a.operations, revokedDeviceIds: a.revokedDeviceIds, requestId: a.requestId,
      authorizationHash: await hash(body.authorization), issuedAt: Date.now() }, serviceId, "RUSTY/2")
    return Response.json({ capability })
  }))
  return { access, binding, repository, profile, requests }
}

it("Given legacy Rusty permissions, when a background setup reads status, then require explicit migration without publishing a policy or rewriting identity", async () => {
  const f = await fixture()
  const before = structuredClone(f.profile.certificate)
  await expect(ensureRustyPersonPolicy(f.access, f.profile, true)).rejects.toBeInstanceOf(RustyPermissionMigrationRequiredError)
  expect(f.requests.map(request => request.url)).toEqual([`${f.access.origin}/v2/management/person/${f.binding.resourceId}/status`])
  expect(await f.repository.read(f.binding)).toBeUndefined()
  expect((await bootstrapIdentity()).certificate).toEqual(before)
})

it("Given an explicit owner migration, when Rusty confirms person authority, then retain the exact service/device pins and permit later background reads without another update", async () => {
  const f = await fixture()
  const device = f.profile.device.deviceId, certificate = structuredClone(f.profile.certificate)
  const confirmed = await ensureRustyPersonPolicy(f.access, f.profile, true, { allowLegacyMigration: true })
  expect(confirmed?.payload).toMatchObject({ resourceKind: "person", resourceId: f.binding.resourceId, revision: 1 })
  expect((await f.repository.read(f.binding))?.capability).toEqual(confirmed)
  await ensureRustyPersonPolicy(f.access, f.profile, true)
  expect(f.requests.filter(request => !request.url.endsWith("/status"))).toHaveLength(1)
  expect((await bootstrapIdentity()).device.deviceId).toBe(device)
  expect((await bootstrapIdentity()).certificate).toEqual(certificate)
})

it("Given a saved owner migration with an uncertain response, when retrying without new approval, then recover the original authorized request", async () => {
  const f = await fixture()
  const originalFetch = fetch
  let interrupted = false
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    const response = await originalFetch(url, init)
    if (!url.endsWith("/status") && !interrupted) { interrupted = true; throw new Error("confirmation lost") }
    return response
  }))
  await expect(ensureRustyPersonPolicy(f.access, f.profile, true, { allowLegacyMigration: true })).rejects.toThrow("confirmation lost")
  expect((await f.repository.read(f.binding))?.pending).toBeDefined()
  await ensureRustyPersonPolicy(f.access, f.profile, true)
  expect((await f.repository.read(f.binding))?.pending).toBeUndefined()
  expect(f.requests.filter(request => !request.url.endsWith("/status"))).toHaveLength(1)
})
