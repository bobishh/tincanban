import { beforeEach, describe, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, signEnvelope, type LocalProfile } from "./identity"
import { certHashDefault, createDelegatedCertificate } from "./proofs"
import { resolveSigningContext } from "./signingContext"
import { createAutomationInstanceRequest, verifyAutomationInstanceRequest,
  type AutomationInstanceRequestInput } from "./automationInstanceProtocol"

const origin = "https://automation.example.test"
const input = (overrides: Partial<AutomationInstanceRequestInput> = {}): AutomationInstanceRequestInput => ({
  action: "discover", origin, workspaceId: "workspace-1", definitionId: "typed-definition",
  integrationId: null, executorPersonId: "worker-person", bodyHash: "a".repeat(43), ...overrides,
})
const expected = (value: AutomationInstanceRequestInput) => ({ ...value })

async function contextFor(profile: LocalProfile, value: AutomationInstanceRequestInput,
  current: () => Promise<{ personId: string; deviceId: string; authorityRevision: string }> = async () => ({
    personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: "owner-revision",
  })) {
  return resolveSigningContext({ profile, certificates: [], purpose: "automation-instance-request", authorityRevision: "owner-revision",
    binding: { action: value.action, origin: value.origin, workspaceId: value.workspaceId, definitionId: value.definitionId,
      ...(value.integrationId === null ? {} : { integrationId: value.integrationId }),
      executorPersonId: value.executorPersonId, bodyHash: value.bodyHash }, current })
}

describe("signed automation instance request", () => {
  beforeEach(() => resetIdentityStorageForTest())

  it("Given a live owner signing context, When creating discover and instance requests, Then sign exact fresh scoped payloads", async () => {
    const owner = await bootstrapIdentity("Automation owner")
    for (const request of [input(), input({ action: "identity", integrationId: "legacy-route" }),
      input({ action: "activate", integrationId: "legacy-route" })]) {
      const proof = await createAutomationInstanceRequest(await contextFor(owner, request), request)
      await expect(verifyAutomationInstanceRequest(proof, expected(request))).resolves.toMatchObject({
        ...request, kind: "automation-instance-request", version: 1, personId: owner.identity.personId,
        deviceId: owner.device.deviceId, nonce: expect.any(String), issuedAt: expect.any(Number), expiresAt: expect.any(Number),
      })
    }
  })

  it("Given a storage-policy receipt, When signing refresh-access, Then bind exact body hash and integration route without falling back to activation", async () => {
    const owner = await bootstrapIdentity("Automation owner")
    const request = input({ action: "refresh-access" as never, integrationId: "legacy-route", bodyHash: "c".repeat(43) })
    const proof = await createAutomationInstanceRequest(await contextFor(owner, request), request)
    await expect(verifyAutomationInstanceRequest(proof, expected(request))).resolves.toMatchObject({
      action: "refresh-access", integrationId: "legacy-route", bodyHash: "c".repeat(43),
      personId: owner.identity.personId, deviceId: owner.device.deviceId,
    })
    await expect(verifyAutomationInstanceRequest(proof, expected({ ...request, action: "activate" as never })))
      .rejects.toThrow()
  })

  it("Given request fields differ or violate action rules, When creating or verifying, Then reject the request", async () => {
    const owner = await bootstrapIdentity("Automation owner")
    const request = input({ action: "activate", integrationId: "legacy-route" })
    const proof = await createAutomationInstanceRequest(await contextFor(owner, request), request)
    for (const mismatch of [
      { ...request, action: "identity" as const }, { ...request, origin: "https://other.example.test" },
      { ...request, workspaceId: "workspace-2" }, { ...request, definitionId: "other-definition" },
      { ...request, integrationId: "other-route" }, { ...request, executorPersonId: "other-worker" },
      { ...request, bodyHash: "b".repeat(43) },
    ]) await expect(verifyAutomationInstanceRequest(proof, mismatch)).rejects.toThrow()
    for (const invalid of [
      input({ action: "activate", integrationId: null }),
      input({ action: "identity", integrationId: null }),
      input({ origin: "http://automation.example.test" }),
      input({ definitionId: "bad/id" }), input({ workspaceId: " " }), input({ bodyHash: "short" }),
    ]) await expect(createAutomationInstanceRequest(await contextFor(owner, request), invalid)).rejects.toThrow()
    await expect(verifyAutomationInstanceRequest({ ...proof, extra: true }, expected(request))).rejects.toThrow()
    const wrongPurpose = await resolveSigningContext({ profile: owner, certificates: [], purpose: "wrong-purpose",
      authorityRevision: "owner-revision", binding: { action: request.action, origin: request.origin,
        workspaceId: request.workspaceId, definitionId: request.definitionId, integrationId: request.integrationId!,
        executorPersonId: request.executorPersonId, bodyHash: request.bodyHash }, current: async () => ({
        personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision: "owner-revision",
      }) })
    await expect(createAutomationInstanceRequest(wrongPurpose, request)).rejects.toThrow(/purpose/i)
  })

  it("Given a tampered or stale proof, When verifying, Then reject its signature and freshness", async () => {
    const owner = await bootstrapIdentity("Automation owner")
    const request = input({ action: "identity", integrationId: "legacy-route" })
    const proof = await createAutomationInstanceRequest(await contextFor(owner, request), request)
    const altered = structuredClone(proof)
    altered.signed.payload.executorPersonId = "other-worker"
    await expect(verifyAutomationInstanceRequest(altered, expected(request))).rejects.toThrow()
    const now = Date.now()
    for (const patch of [{ issuedAt: now + 5_001, expiresAt: now + 10_000 },
      { issuedAt: now - 70_000, expiresAt: now - 10_000 },
      { issuedAt: now, expiresAt: now + 60_001 }]) {
      const payload = { ...proof.signed.payload, ...patch }
      const signed = await signEnvelope(owner.privateKeys.devicePrivateKey, payload, owner.device.deviceId)
      await expect(verifyAutomationInstanceRequest({ ...proof, signed }, expected(request), now)).rejects.toThrow(/fresh|lifetime|expired/i)
    }
    await expect(verifyAutomationInstanceRequest({ ...proof, padding: "x".repeat(129 * 1024) }, expected(request)))
      .rejects.toThrow(/size/i)
  })

  it("Given a delegated owner device, When proof omits an ancestor or adds an unrelated certificate, Then reject the chain", async () => {
    const root = await bootstrapIdentity("Automation owner")
    resetIdentityStorageForTest()
    const temporary = await bootstrapIdentity("Delegated device")
    const leaf = await createDelegatedCertificate(root.privateKeys.devicePrivateKey, root.device.deviceId,
      root.identity.personId, temporary.device.deviceId, temporary.device.publicKey, await certHashDefault(root.certificate))
    const delegated: LocalProfile = { ...temporary, identity: root.identity, certificate: leaf,
      privateKeys: { devicePrivateKey: temporary.privateKeys.devicePrivateKey } }
    const request = input({ action: "activate", integrationId: "old-route" })
    const context = await resolveSigningContext({ profile: delegated, certificates: [root.certificate],
      purpose: "automation-instance-request", authorityRevision: "owner-revision", binding: {
        action: request.action, origin: request.origin, workspaceId: request.workspaceId, definitionId: request.definitionId,
        integrationId: request.integrationId!, executorPersonId: request.executorPersonId, bodyHash: request.bodyHash,
      }, current: async () => ({ personId: root.identity.personId, deviceId: delegated.device.deviceId, authorityRevision: "owner-revision" }) })
    const proof = await createAutomationInstanceRequest(context, request)
    expect(proof.certificates).toHaveLength(2)
    await expect(verifyAutomationInstanceRequest({ ...proof, certificates: [leaf] }, expected(request))).rejects.toThrow(/chain|certificate/i)
    await expect(verifyAutomationInstanceRequest({ ...proof, certificates: [...proof.certificates, root.certificate] }, expected(request)))
      .rejects.toThrow(/chain|certificate|duplicate/i)
  })

  it("Given verification is awaiting crypto, When caller mutates proof, Then verify its captured envelope", async () => {
    const owner = await bootstrapIdentity("Automation owner")
    const request = input()
    const proof = await createAutomationInstanceRequest(await contextFor(owner, request), request)
    const expectedRequest = expected(request)
    const pending = verifyAutomationInstanceRequest(proof, expectedRequest)
    proof.publicKey = "mutated"
    proof.certificates[0]!.signature = "mutated"
    proof.signed.payload.workspaceId = "mutated"
    expectedRequest.workspaceId = "different-workspace"
    await expect(pending).resolves.toMatchObject({ workspaceId: "workspace-1" })
  })

  it("Given caller input changes while signing, When signing finishes, Then sign the entry snapshot", async () => {
    const owner = await bootstrapIdentity("Automation owner")
    const request = input()
    let wait = false
    let entered!: () => void
    let release!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    const context = await contextFor(owner, request, async () => {
      if (wait) { entered(); await gate }
      return { personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision: "owner-revision" }
    })
    wait = true
    const pending = createAutomationInstanceRequest(context, request)
    await waiting
    request.workspaceId = "mutated-workspace"
    release()
    const proof = await pending
    expect(proof.signed.payload.workspaceId).toBe("workspace-1")
  })
})
