import { beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope, verifyEnvelope, type LocalProfile } from "./identity"
import { certHashDefault, createDelegatedCertificate } from "./proofs"
import { resolveSigningContext, signingEvidence, signWithContext } from "./signingContext"

let owner: LocalProfile
let device: LocalProfile
beforeEach(async () => {
  resetIdentityStorageForTest(); owner = await bootstrapIdentity("Owner")
  resetIdentityStorageForTest(); const temporary = await bootstrapIdentity("Device")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, temporary.device.deviceId, temporary.device.publicKey, await certHashDefault(owner.certificate))
  device = { ...temporary, identity: owner.identity, certificate, privateKeys: { devicePrivateKey: temporary.privateKeys.devicePrivateKey } }
})

function request(overrides: Record<string, unknown> = {}) {
  return { profile: device, certificates: [owner.certificate], purpose: "workspace-changes",
    binding: { workspaceId: "workspace" }, authorityRevision: "1",
    current: async () => ({ personId: device.identity.personId, deviceId: device.device.deviceId, authorityRevision: "1" }), ...overrides }
}

it("Given an enrolled signer without a root private key, when resolving and signing, then retain the complete validated chain", async () => {
  const context = await resolveSigningContext(request())
  const signed = await signWithContext(context, { kind: "workspace-changes", version: 1, workspaceId: "workspace", hashes: ["change"] })
  expect(await verifyEnvelope(signed, device.device.publicKey)).toBe(true)
  expect(signed.signerKeyId).toBe(device.device.deviceId)
  expect(signingEvidence(context).certificates).toEqual([device.certificate, owner.certificate])
  expect(JSON.stringify(context)).not.toContain("privateKey")
})

it("Given history signer evidence repeated across owner authority and proof storage, when resolving, then export only the exact certified chain", async () => {
  const original = structuredClone([owner.certificate, device.certificate, owner.certificate])
  const context = await resolveSigningContext(request({ purpose: "workspace-history-baseline",
    domain: "MESH-HISTORY/1", certificates: original }))
  expect(signingEvidence(context).certificates).toEqual([device.certificate, owner.certificate])
  expect(original).toEqual([owner.certificate, device.certificate, owner.certificate])
})

it("Given runtime-only private metadata in public evidence, when resolving, then reject it before evidence can be exported", async () => {
  const identityWithSecret = { ...device.identity, privateKeys: { devicePrivateKey: "must-not-leak" } }
  await expect(resolveSigningContext(request({ profile: { ...device, identity: identityWithSecret } })))
    .rejects.toThrow(/identity|evidence|schema/i)

  const envelopeWithSecret = { ...device.certificate, privateKey: "must-not-leak" }
  await expect(resolveSigningContext(request({ profile: { ...device, certificate: envelopeWithSecret } })))
    .rejects.toThrow(/certificate|evidence|schema/i)

  const payloadWithExtra = { ...device.certificate, payload: { ...device.certificate.payload, secret: "must-not-leak" } }
  await expect(resolveSigningContext(request({ profile: { ...device, certificate: payloadWithExtra } })))
    .rejects.toThrow(/certificate|evidence|schema/i)
})

it("Given a missing or forged ancestor, when resolving a signing context, then reject before signing any application payload", async () => {
  await expect(resolveSigningContext(request({ certificates: [] }))).rejects.toThrow(/ancestor|certificate|evidence/i)
  await expect(resolveSigningContext(request({ certificates: [{ ...owner.certificate, signature: "forged" }] }))).rejects.toThrow()
})

it("Given a private key from another device, when resolving, then reject its mismatch with the certified signing key", async () => {
  const mismatched = { ...device, privateKeys: { devicePrivateKey: owner.privateKeys.devicePrivateKey } }
  await expect(resolveSigningContext(request({ profile: mismatched }))).rejects.toThrow(/key|signer/i)
})

it("Given a valid non-enrolling leaf certificate, when signing ordinary workspace data, then allow signing but reject delegation through that leaf", async () => {
  const nonEnrollingPayload = { ...device.certificate.payload, issuerCertificateHash: null, canEnrollDevices: false }
  const nonEnrollingCertificate = await signEnvelope(owner.privateKeys.identityPrivateKey!, nonEnrollingPayload, owner.identity.personId)
  const nonEnrollingProfile = { ...device, certificate: nonEnrollingCertificate as unknown as LocalProfile["certificate"] }
  const context = await resolveSigningContext(request({ profile: nonEnrollingProfile, certificates: [] }))
  const signed = await signWithContext(context, { kind: "workspace-changes", version: 1, workspaceId: "workspace", hashes: ["change"] })
  expect(await verifyEnvelope(signed, device.device.publicKey)).toBe(true)

  resetIdentityStorageForTest()
  const child = await bootstrapIdentity("Child")
  const delegated = await createDelegatedCertificate(device.privateKeys.devicePrivateKey!, device.device.deviceId,
    owner.identity.personId, child.device.deviceId, child.device.publicKey, await certHashDefault(nonEnrollingCertificate as unknown as LocalProfile["certificate"]))
  const childProfile = { ...child, identity: owner.identity, certificate: delegated,
    privateKeys: { devicePrivateKey: child.privateKeys.devicePrivateKey } }
  await expect(resolveSigningContext(request({ profile: childProfile, certificates: [nonEnrollingCertificate] })))
    .rejects.toThrow(/chain|ancestor|certificate/i)
})

it("Given a verified context, when signing another scope or purpose, then reject substitution", async () => {
  const context = await resolveSigningContext(request())
  await expect(signWithContext(context, { kind: "workspace-changes", workspaceId: "other" })).rejects.toThrow(/binding|scope/i)
  await expect(signWithContext(context, { kind: "scope-genesis", workspaceId: "workspace" })).rejects.toThrow(/purpose/i)
  await expect(signWithContext({ ...context }, { kind: "workspace-changes", workspaceId: "workspace" })).rejects.toThrow(/context/i)
})

it("Given numeric scope bindings, when signing, then require exact numeric type and value before crypto", async () => {
  const context = await resolveSigningContext(request({ binding: { workspaceId: "workspace", keyEpoch: 1 } }))
  const original = crypto.subtle.sign.bind(crypto.subtle)
  const sign = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => original(...args))
  try {
    await expect(signWithContext(context, { kind: "workspace-changes", workspaceId: "workspace", keyEpoch: "1" }))
      .rejects.toThrow(/binding|scope/i)
    await expect(signWithContext(context, { kind: "workspace-changes", workspaceId: "workspace", keyEpoch: 2 }))
      .rejects.toThrow(/binding|scope/i)
    expect(sign).not.toHaveBeenCalled()

    const signed = await signWithContext(context, { kind: "workspace-changes", workspaceId: "workspace", keyEpoch: 1 })
    expect(await verifyEnvelope(signed, device.device.publicKey)).toBe(true)
  } finally { sign.mockRestore() }
})

it.each([Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true, ""]) (
  "Given invalid scope binding %s, when resolving a signing context, then reject before cryptography",
  async invalid => {
    const original = crypto.subtle.sign.bind(crypto.subtle)
    const sign = vi.spyOn(crypto.subtle, "sign").mockImplementation(async (...args) => original(...args))
    try {
      await expect(resolveSigningContext(request({ binding: { keyEpoch: invalid } }))).rejects.toThrow(/binding/i)
      expect(sign).not.toHaveBeenCalled()
    } finally { sign.mockRestore() }
  },
)

it("Given authority or identity changing after resolution, when signing, then reject the stale context", async () => {
  let revision = "1"
  const context = await resolveSigningContext(request({ current: async () => ({ personId: device.identity.personId, deviceId: device.device.deviceId, authorityRevision: revision }) }))
  revision = "2"
  await expect(signWithContext(context, { kind: "workspace-changes", workspaceId: "workspace" })).rejects.toThrow(/authority|stale/i)
})

it("Given expiry crossed while the current-authority check waits, when signing resumes, then no successful signature is returned", async () => {
  let now = 0
  const current = vi.fn(async () => ({ personId: device.identity.personId, deviceId: device.device.deviceId, authorityRevision: "1" }))
  const context = await resolveSigningContext(request({ expiresAt: 10, now: () => now, current }))
  current.mockImplementationOnce(async () => { now = 20; return { personId: device.identity.personId, deviceId: device.device.deviceId, authorityRevision: "1" } })
  await expect(signWithContext(context, { kind: "workspace-changes", workspaceId: "workspace" })).rejects.toThrow(/expired/i)
})

it("Given mutable caller evidence and payload, when context resolution and signing finish, then later mutation cannot change retained signed evidence", async () => {
  const ancestor = structuredClone(owner.certificate)
  const context = await resolveSigningContext(request({ certificates: [ancestor] }))
  ancestor.signature = "modified"
  const evidence = signingEvidence(context)
  evidence.certificates[0].signature = "modified"
  const payload = { kind: "workspace-changes", workspaceId: "workspace", hashes: ["original"] }
  const signed = await signWithContext(context, payload)
  payload.hashes[0] = "modified"
  expect(signingEvidence(context).certificates[0].signature).toBe(device.certificate.signature)
  expect(signed.payload.hashes).toEqual(["original"])
  expect(await verifyEnvelope(signed, device.device.publicKey)).toBe(true)
})

it("Given the caller mutates its request during key verification, when resolution finishes, then retain the originally requested purpose and scope", async () => {
  const input = request()
  const original = crypto.subtle.sign.bind(crypto.subtle)
  const sign = vi.spyOn(crypto.subtle, "sign").mockImplementationOnce(async (...args) => {
    const signed = await original(...args)
    input.purpose = "scope-genesis"
    input.binding.workspaceId = "different"
    return signed
  })
  try {
    const context = await resolveSigningContext(input)
    expect(context.purpose).toBe("workspace-changes")
    const signed = await signWithContext(context, { kind: "workspace-changes", workspaceId: "workspace" })
    expect(await verifyEnvelope(signed, device.device.publicKey)).toBe(true)
  } finally { sign.mockRestore() }
})
