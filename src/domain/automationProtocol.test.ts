import { beforeEach, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope } from "./identity"
import { createAutomationOwnerRequest, verifyAutomationOwnerRequest, verifyAutomationObservation } from "./automationProtocol"

beforeEach(resetIdentityStorageForTest)
it("Given an approved owner, when enrollment is signed, then origin, workspace and instance are bound without an operator token", async () => {
  const profile = await bootstrapIdentity("Owner")
  const request = await createAutomationOwnerRequest(profile, { action: "enroll", origin: "https://worker.example.test",
    workspaceId: "workspace", integrationId: crypto.randomUUID(), bodyHash: null })
  const payload = await verifyAutomationOwnerRequest(request, "https://worker.example.test", [profile.identity.personId])
  expect(payload).toMatchObject({ workspaceId: "workspace", action: "enroll" })
  await expect(verifyAutomationOwnerRequest(request, "https://other.example.test", [profile.identity.personId])).rejects.toThrow()
  await expect(verifyAutomationOwnerRequest(request, "https://worker.example.test", [])).rejects.toThrow()
})
it("Given signed activation, when its body or freshness changes, then proof cannot authorize the altered request", async () => {
  const profile = await bootstrapIdentity("Owner")
  const request = await createAutomationOwnerRequest(profile, { action: "activate", origin: "https://worker.example.test",
    workspaceId: "workspace", integrationId: crypto.randomUUID(), bodyHash: await sha256Base64Url(new TextEncoder().encode("packet")) })
  const owners = [profile.identity.personId]
  await expect(verifyAutomationOwnerRequest({ ...request, signed: { ...request.signed,
    payload: { ...request.signed.payload, workspaceId: "forged" } } }, request.signed.payload.origin, owners)).rejects.toThrow()
  await expect(verifyAutomationOwnerRequest(request, request.signed.payload.origin, owners, Date.now() + 120_000)).rejects.toThrow()
})

it("Given a Worker acknowledgement, when its identity, nonce or freshness differs, then the UI cannot confirm execution state", async () => {
  const worker = await bootstrapIdentity("Worker")
  const expected = { personId: worker.identity.personId, origin: "https://worker.example.test", integrationId: crypto.randomUUID(),
    workspaceId: "workspace", grantId: "grant", nonce: crypto.randomUUID() }
  const payload = { kind: "automation-observation", version: 1, origin: expected.origin, integrationId: expected.integrationId,
    workspaceId: expected.workspaceId, grantId: expected.grantId, nonce: expected.nonce, issuedAt: Date.now(),
    state: "paused", heads: [crypto.randomUUID()] }
  const proof = { publicKey: worker.identity.publicKey, certificates: [worker.certificate],
    signed: await signEnvelope(worker.privateKeys.devicePrivateKey, payload, worker.device.deviceId) }
  expect(await verifyAutomationObservation(proof, expected)).toMatchObject({ state: "paused", heads: payload.heads })
  for (const patch of [{ personId: "another-worker" }, { nonce: crypto.randomUUID() }, { grantId: "another-grant" }]) {
    await expect(verifyAutomationObservation(proof, { ...expected, ...patch })).rejects.toThrow()
  }
  await expect(verifyAutomationObservation(proof, expected, Date.now() + 120_000)).rejects.toThrow()
  await expect(verifyAutomationObservation({ ...proof, signed: { ...proof.signed, payload: { ...payload, state: "active" } } }, expected)).rejects.toThrow()
})
it("Given an owner enrolled on another device, when enrollment is signed, then the full certificate chain authorizes it", async () => {
  const owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest()
  const device = await bootstrapIdentity("Second device")
  const { createDelegatedCertificate, certHashDefault } = await import("./proofs")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, device.device.deviceId, device.device.publicKey, await certHashDefault(owner.certificate))
  const delegated = { ...device, identity: owner.identity, certificate }
  await expect(createAutomationOwnerRequest(delegated, { action: "enroll", origin: "https://worker.example.test",
    workspaceId: "workspace", integrationId: crypto.randomUUID(), bodyHash: null })).rejects.toThrow("Device trust chain is incomplete")
  const request = await createAutomationOwnerRequest(delegated, { action: "enroll", origin: "https://worker.example.test",
    workspaceId: "workspace", integrationId: crypto.randomUUID(), bodyHash: null }, [owner.certificate])
  expect(request.certificates).toHaveLength(2)
  await expect(verifyAutomationOwnerRequest(request, "https://worker.example.test", [owner.identity.personId])).resolves.toMatchObject({ personId: owner.identity.personId })
})
