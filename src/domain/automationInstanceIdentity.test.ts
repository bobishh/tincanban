import { beforeEach, describe, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { resolveSigningContext } from "./signingContext"
import { parseAutomationInstanceDescription, type AutomationInstanceDescription } from "./automationInstanceData"
import { createAutomationInstanceIdentity, verifyAutomationInstanceIdentity,
  type AutomationInstanceIdentityInput } from "./automationInstanceIdentity"

const origin = "https://automation.example.test"
const description = (overrides: Partial<AutomationInstanceDescription> = {}): AutomationInstanceDescription => ({
  workspaceId: "workspace-1", boardId: "board-1", definitionId: "typed-definition", executorPersonId: "owner-person",
  grantId: "expired-grant", expiresAt: 1, state: "paused", adoptionRequired: false, ...overrides,
})
const input = (owner: LocalProfile, overrides: Partial<AutomationInstanceIdentityInput> = {}): AutomationInstanceIdentityInput => ({
  origin, workspaceId: "workspace-1", definitionId: "typed-definition", integrationId: "legacy-route",
  requestNonce: crypto.randomUUID(), description: description({ executorPersonId: owner.identity.personId }), ...overrides,
})

async function contextFor(owner: LocalProfile, request: AutomationInstanceIdentityInput) {
  return resolveSigningContext({ profile: owner, certificates: [], purpose: "automation-instance-identity",
    authorityRevision: "owner-authority", binding: { origin: request.origin, workspaceId: request.workspaceId,
      definitionId: request.definitionId, integrationId: request.integrationId }, current: async () => ({
      personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision: "owner-authority",
    }) })
}

describe("signed automation instance identity", () => {
  beforeEach(() => resetIdentityStorageForTest())

  it("Given an owner-signed instance snapshot, When created and verified, Then retain expired grant metadata under a fresh device proof", async () => {
    const owner = await bootstrapIdentity("Instance owner")
    const request = input(owner)
    const proof = await createAutomationInstanceIdentity(await contextFor(owner, request), request)
    await expect(verifyAutomationInstanceIdentity(proof, {
      origin, workspaceId: request.workspaceId, definitionId: request.definitionId,
      integrationId: request.integrationId, executorPersonId: owner.identity.personId,
      requestNonce: proof.signed.payload.requestNonce,
    })).resolves.toMatchObject({ description: { grantId: "expired-grant", expiresAt: 1 },
      executorPersonId: owner.identity.personId, deviceId: owner.device.deviceId })
  })

  it("Given altered scope or signer evidence, When verified, Then reject substitution and incomplete chains", async () => {
    const owner = await bootstrapIdentity("Instance owner")
    const request = input(owner)
    const proof = await createAutomationInstanceIdentity(await contextFor(owner, request), request)
    const expected = { origin, workspaceId: request.workspaceId, definitionId: request.definitionId,
      integrationId: request.integrationId, executorPersonId: owner.identity.personId,
      requestNonce: proof.signed.payload.requestNonce }
    for (const mismatch of [{ ...expected, origin: "https://other.example.test" },
      { ...expected, workspaceId: "workspace-2" }, { ...expected, definitionId: "other-definition" },
      { ...expected, integrationId: "other-route" }, { ...expected, executorPersonId: "other-person" },
      { ...expected, requestNonce: crypto.randomUUID() }]) {
      await expect(verifyAutomationInstanceIdentity(proof, mismatch)).rejects.toThrow()
    }
    await expect(verifyAutomationInstanceIdentity({ ...proof, certificates: [] }, expected)).rejects.toThrow()
    await expect(verifyAutomationInstanceIdentity({ ...proof, publicKey: "foreign-key" }, expected)).rejects.toThrow()
  })

  it("Given stale or future proof times, When verified, Then reject outside the freshness window", async () => {
    const owner = await bootstrapIdentity("Instance owner")
    const request = input(owner)
    const proof = await createAutomationInstanceIdentity(await contextFor(owner, request), request)
    const expected = { origin, workspaceId: request.workspaceId, definitionId: request.definitionId,
      integrationId: request.integrationId, executorPersonId: owner.identity.personId,
      requestNonce: proof.signed.payload.requestNonce }
    await expect(verifyAutomationInstanceIdentity(proof, expected, proof.signed.payload.issuedAt - 5_001)).rejects.toThrow(/fresh/i)
    await expect(verifyAutomationInstanceIdentity(proof, expected, proof.signed.payload.issuedAt + 60_001)).rejects.toThrow(/fresh/i)
    await expect(verifyAutomationInstanceIdentity({ ...proof, padding: "x".repeat(129 * 1024) }, expected)).rejects.toThrow(/size/i)
  })

  it("Given verification awaits cryptography, When caller mutates proof and expectation, Then verify the captured values", async () => {
    const owner = await bootstrapIdentity("Instance owner")
    const request = input(owner)
    const proof = await createAutomationInstanceIdentity(await contextFor(owner, request), request)
    const expected = { origin, workspaceId: request.workspaceId, definitionId: request.definitionId,
      integrationId: request.integrationId, executorPersonId: owner.identity.personId,
      requestNonce: proof.signed.payload.requestNonce }
    const pending = verifyAutomationInstanceIdentity(proof, expected)
    proof.signed.payload.workspaceId = "mutated"
    proof.certificates[0]!.signature = "mutated"
    expected.workspaceId = "mutated"
    await expect(pending).resolves.toMatchObject({ workspaceId: "workspace-1" })
  })

  it("Given an adoption identity, When creating, Then require null requested definition and strict adoption metadata", async () => {
    const owner = await bootstrapIdentity("Instance owner")
    const request = input(owner, { description: description({ definitionId: null, adoptionRequired: true,
      executorPersonId: owner.identity.personId }) })
    const proof = await createAutomationInstanceIdentity(await contextFor(owner, request), request)
    expect(proof.signed.payload.description.definitionId).toBeNull()
    await expect(createAutomationInstanceIdentity(await contextFor(owner, request), { ...request,
      description: description({ definitionId: null, adoptionRequired: false,
        executorPersonId: owner.identity.personId }) })).rejects.toThrow()
    expect(() => parseAutomationInstanceDescription(description({ definitionId: null }))).toThrow()
  })
})
