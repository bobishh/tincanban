import { afterEach, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, toBase64Url } from "../domain/identity"
import { RustyManagementRepository, type ManagementBinding, type ManagementUpdateRequest } from "./rustyManagementRepository"
import type { RustyManagementCapability } from "./rustyManagementCapability"

afterEach(() => resetIdentityStorageForTest())

it("Given a pending policy request, When imported signed evidence revokes this device, Then retain evidence and unresolved intent atomically", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Management owner")
  const service = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const rawServiceKey = new Uint8Array(await crypto.subtle.exportKey("raw", service.publicKey))
  const serviceId = await sha256Base64Url(rawServiceKey)
  const binding: ManagementBinding = {
    origin: "https://rusty.example", servicePublicKey: toBase64Url(rawServiceKey), resourceKind: "scope", resourceId: "scope-pending",
  }
  const owner = profile.identity.personId
  const repository = new RustyManagementRepository(owner)
  const authPayload = {
    kind: "rusty-management-policy-update" as const, version: 1 as const, serviceId, origin: binding.origin,
    personId: owner, deviceId: profile.device.deviceId, resourceKind: binding.resourceKind, resourceId: binding.resourceId,
    expectedRevision: 0, operations: ["management.update", "scope.policy"], revokedDeviceIds: [],
    requestId: "bootstrap-update", issuedAt: Date.now(), expiresAt: Date.now() + 120_000,
  }
  const request: ManagementUpdateRequest = {
    version: 1, identity: profile.identity, deviceId: profile.device.deviceId, certificates: [profile.certificate],
    authorization: await signEnvelope(profile.privateKeys.devicePrivateKey, authPayload, profile.device.deviceId),
  }
  await repository.prepare(binding, request)

  const revokedCapability: RustyManagementCapability = {
    kind: "rusty-scope-management-capability", version: 1, serviceId, origin: binding.origin, personId: owner,
    resourceKind: "scope", resourceId: binding.resourceId, revision: 1,
    operations: ["management.update", "scope.policy"], revokedDeviceIds: [profile.device.deviceId],
    requestId: "external-policy-update", authorizationHash: "A".repeat(43), issuedAt: Date.now(),
  }
  const signed = await signEnvelope(service.privateKey, revokedCapability, serviceId, "RUSTY/2")
  await repository.observe(binding, signed)

  const reopened = new RustyManagementRepository(owner)
  const saved = await reopened.read(binding)
  expect(saved?.capability).toEqual(signed)
  expect(saved?.capability?.payload.revokedDeviceIds).toContain(profile.device.deviceId)
  expect(saved?.pending).toEqual(request)
})
