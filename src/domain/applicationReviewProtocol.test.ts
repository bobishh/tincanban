import { beforeEach, describe, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { certHashDefault, createDelegatedCertificate } from "./proofs"
import { createApplicationReviewRequest, verifyApplicationReviewRequest, type ApplicationReviewRequestInput } from "./applicationReviewProtocol"
import { verifyDeviceProofSignature } from "./deviceProof"
import { resolveSigningContext } from "./signingContext"

const origin = "https://automation.example.test"
const input = (overrides: Partial<ApplicationReviewRequestInput> = {}): ApplicationReviewRequestInput => ({
  action: "discover", origin, workspaceId: "workspace-1", definitionId: "application-definition",
  integrationId: null, bodyHash: "a".repeat(43), ...overrides,
})
const expected = (value: ApplicationReviewRequestInput) => ({ ...value })

async function contextFor(profile: LocalProfile, value: ApplicationReviewRequestInput,
  current: () => Promise<{ personId: string; deviceId: string; authorityRevision: string }> = async () => ({
    personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: "authority-1",
  })) {
  return resolveSigningContext({ profile, certificates: [], purpose: "automation-application-review-request",
    authorityRevision: "authority-1", binding: { action: value.action, origin: value.origin, workspaceId: value.workspaceId,
      definitionId: value.definitionId, bodyHash: value.bodyHash, ...(value.integrationId ? { integrationId: value.integrationId } : {}) }, current })
}

describe("signed application review request", () => {
  beforeEach(() => resetIdentityStorageForTest())

  it("Given a verified owner context, When creating a request, Then sign an exact fresh discovery proof", async () => {
    const owner = await bootstrapIdentity("Review owner")
    const request = input()
    const proof = await createApplicationReviewRequest(await contextFor(owner, request), request)
    expect(await verifyApplicationReviewRequest(proof, expected(request))).toMatchObject({ ...request,
      kind: "automation-application-review-request", version: 1, personId: owner.identity.personId,
      deviceId: owner.device.deviceId, nonce: expect.any(String), expiresAt: expect.any(Number) })
  })

  it("Given a list request, When signing and verifying, Then require its integration route and bind the list action", async () => {
    const owner = await bootstrapIdentity("Review owner")
    const request = input({ action: "list", integrationId: "legacy_worker-1" })
    const proof = await createApplicationReviewRequest(await contextFor(owner, request), request)
    await expect(verifyApplicationReviewRequest(proof, expected(request))).resolves.toMatchObject(request)

    const altered = structuredClone(proof)
    altered.signed.payload.action = "review"
    await expect(verifyApplicationReviewRequest(altered, expected(request))).rejects.toThrow()
    await expect(createApplicationReviewRequest(await contextFor(owner, input({ action: "list" })),
      input({ action: "list" }))).rejects.toThrow()
  })

  it("Given signed request evidence, When any request binding differs, Then reject before accepting it", async () => {
    const owner = await bootstrapIdentity("Review owner")
    const request = input({ action: "review", integrationId: "legacy_worker-1" })
    const proof = await createApplicationReviewRequest(await contextFor(owner, request), request)
    for (const mismatch of [
      { ...request, action: "bind" as const }, { ...request, origin: "https://other.example.test" },
      { ...request, workspaceId: "workspace-2" }, { ...request, definitionId: "other-definition" },
      { ...request, integrationId: "other-worker" }, { ...request, bodyHash: "b".repeat(43) },
    ]) await expect(verifyApplicationReviewRequest(proof, mismatch)).rejects.toThrow()
    for (const mutate of [
      (payload: Record<string, unknown>) => { payload.action = "retry" },
      (payload: Record<string, unknown>) => { payload.bodyHash = "b".repeat(43) },
      (payload: Record<string, unknown>) => { payload.workspaceId = "workspace-2" },
    ]) {
      const altered = structuredClone(proof)
      mutate(altered.signed.payload as unknown as Record<string, unknown>)
      await expect(verifyApplicationReviewRequest(altered, expected(request))).rejects.toThrow()
    }
  })

  it("Given malformed or stale proof metadata, When verifying, Then reject bad shape, lifetime and clock skew", async () => {
    const owner = await bootstrapIdentity("Review owner")
    const request = input()
    const proof = await createApplicationReviewRequest(await contextFor(owner, request), request)
    expect(() => structuredClone(proof)).not.toThrow()
    for (const alteredPayload of [
      { ...proof.signed.payload, extra: true },
      { ...proof.signed.payload, expiresAt: proof.signed.payload.issuedAt + 60_001 },
      { ...proof.signed.payload, issuedAt: Date.now() + 5_001 },
      { ...proof.signed.payload, expiresAt: Date.now() - 1 },
    ]) await expect(verifyApplicationReviewRequest({ ...proof, signed: { ...proof.signed, payload: alteredPayload } },
      expected(request))).rejects.toThrow()
    const context = await contextFor(owner, request)
    await expect(createApplicationReviewRequest(context, input({ action: "review", integrationId: null } as Partial<ApplicationReviewRequestInput>)))
      .rejects.toThrow()
    await expect(verifyApplicationReviewRequest({ ...proof, unknown: true }, expected(request))).rejects.toThrow()
  })

  it("Given a delegated signing device, When the proof omits an ancestor or adds an unrelated certificate, Then reject the chain", async () => {
    const owner = await bootstrapIdentity("Review owner")
    resetIdentityStorageForTest()
    const temporary = await bootstrapIdentity("Temporary device")
    const leaf = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
      owner.identity.personId, temporary.device.deviceId, temporary.device.publicKey, await certHashDefault(owner.certificate))
    const delegated: LocalProfile = { ...temporary, identity: owner.identity, certificate: leaf,
      privateKeys: { devicePrivateKey: temporary.privateKeys.devicePrivateKey } }
    const request = input({ action: "retry", integrationId: "old-instance" })
    const context = await resolveSigningContext({ profile: delegated, certificates: [owner.certificate],
      purpose: "automation-application-review-request", authorityRevision: "authority-1", binding: {
        action: request.action, origin: request.origin, workspaceId: request.workspaceId, definitionId: request.definitionId,
        bodyHash: request.bodyHash, ...(request.integrationId ? { integrationId: request.integrationId } : {}) },
      current: async () => ({ personId: owner.identity.personId, deviceId: delegated.device.deviceId, authorityRevision: "authority-1" }) })
    const proof = await createApplicationReviewRequest(context, request)
    expect(proof.certificates).toHaveLength(2)
    await expect(verifyApplicationReviewRequest({ ...proof, certificates: [leaf] }, expected(request))).rejects.toThrow(/chain|certificate/i)
    await expect(verifyApplicationReviewRequest({ ...proof, certificates: [...proof.certificates, owner.certificate] }, expected(request)))
      .rejects.toThrow(/chain|certificate|duplicate/i)
  })

  it("Given a stale signing context or caller mutation, When creating the request, Then reject revoked state and preserve entry snapshot", async () => {
    const owner = await bootstrapIdentity("Review owner")
    const request = input()
    let authorityRevision = "authority-1"
    let shouldWait = false
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const context = await contextFor(owner, request, async () => {
      if (shouldWait) { entered(); await gate }
      return { personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision }
    })
    shouldWait = true
    const pending = createApplicationReviewRequest(context, request)
    await waiting
    request.workspaceId = "changed-after-call"
    authorityRevision = "revoked"
    release()
    await expect(pending).rejects.toThrow(/authority|stale/i)

    const fresh = input()
    const validContext = await contextFor(owner, fresh)
    const accepted = await createApplicationReviewRequest(validContext, fresh)
    expect(accepted.signed.payload.workspaceId).toBe("workspace-1")
  })

  it("Given caller input changes while signing, When authority remains current, Then sign the entry snapshot", async () => {
    const owner = await bootstrapIdentity("Review owner")
    const request = input()
    let wait = false
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const context = await contextFor(owner, request, async () => {
      if (wait) { entered(); await gate }
      return { personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision: "authority-1" }
    })
    wait = true
    const pending = createApplicationReviewRequest(context, request)
    await waiting
    request.workspaceId = "changed-after-call"
    release()
    const proof = await pending
    expect(proof.signed.payload.workspaceId).toBe("workspace-1")
  })

  it("Given a public device proof, When the caller mutates it during verification, Then verify the captured envelope", async () => {
    const owner = await bootstrapIdentity("Review owner")
    const request = input()
    const proof = await createApplicationReviewRequest(await contextFor(owner, request), request)
    const pending = verifyDeviceProofSignature(proof, owner.identity.personId, owner.device.deviceId)
    proof.publicKey = "mutated-public-key"
    proof.certificates[0]!.signature = "mutated-certificate-signature"
    proof.signed.payload.workspaceId = "mutated-signed-payload"
    await expect(pending).resolves.toBeDefined()
  })
})
