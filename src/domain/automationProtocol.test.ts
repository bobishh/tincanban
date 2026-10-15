import { beforeEach, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, type LocalProfile } from "./identity"
import type { DeviceCertificate } from "./model"
import { resolveSigningContext } from "./signingContext"
import { createAutomationOwnerRequest as createVerifiedOwnerRequest, verifyAutomationOwnerRequest, verifyAutomationObservation,
  type AutomationOwnerRequestInput } from "./automationProtocol"

async function createAutomationOwnerRequest(profile: LocalProfile, input: AutomationOwnerRequestInput, certificates: DeviceCertificate[] = []) {
  const context = await resolveSigningContext({ profile, certificates, purpose: "automation-owner-request",
    binding: { workspaceId: input.workspaceId, integrationId: input.integrationId, origin: input.origin, action: input.action },
    authorityRevision: "fixture-authority", current: async () => ({ personId: profile.identity.personId,
      deviceId: profile.device.deviceId, authorityRevision: "fixture-authority" }) })
  return createVerifiedOwnerRequest(context, input)
}

beforeEach(resetIdentityStorageForTest)
it("Given a mismatched owner key, when authoring an automation request, then reject the signer binding", async () => {
  const owner = await bootstrapIdentity("Owner")
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  await expect(createAutomationOwnerRequest({ ...owner, privateKeys: { devicePrivateKey: pair.privateKey } },
    { action: "enroll", origin: "https://worker.example.test", workspaceId: "workspace", integrationId: crypto.randomUUID(),
      bodyHash: null })).rejects.toThrow(/key|signer/)
})
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
    workspaceId: "workspace", integrationId: crypto.randomUUID(), bodyHash: null })).rejects.toThrow(/ancestor|certificate/)
  const request = await createAutomationOwnerRequest(delegated, { action: "enroll", origin: "https://worker.example.test",
    workspaceId: "workspace", integrationId: crypto.randomUUID(), bodyHash: null }, [owner.certificate])
  expect(request.certificates).toHaveLength(2)
  await expect(verifyAutomationOwnerRequest(request, "https://worker.example.test", [owner.identity.personId])).resolves.toMatchObject({ personId: owner.identity.personId })
})

it("Given unrelated certificate evidence, when verifying a Worker observation, then reject the extra chain", async () => {
  const worker = await bootstrapIdentity("Worker")
  resetIdentityStorageForTest()
  const unrelated = await bootstrapIdentity("Unrelated")
  const expected = { personId: worker.identity.personId, origin: "https://worker.example.test", integrationId: "legacy-definition",
    workspaceId: "workspace", grantId: "grant", nonce: crypto.randomUUID() }
  const payload = { kind: "automation-observation", version: 1, origin: expected.origin, integrationId: expected.integrationId,
    workspaceId: expected.workspaceId, grantId: expected.grantId, nonce: expected.nonce, issuedAt: Date.now(),
    state: "active", heads: [crypto.randomUUID()] }
  const observation = { publicKey: worker.identity.publicKey, certificates: [worker.certificate, unrelated.certificate],
    signed: await signEnvelope(worker.privateKeys.devicePrivateKey, payload, worker.device.deviceId) }
  await expect(verifyAutomationObservation(observation, expected)).rejects.toThrow(/outside|chain|certificate/)
})
