import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "../domain/identity"
import type { AutomationInstanceDescription } from "../domain/automationInstanceData"
import type { AutomationInstanceIdentityPayload, AutomationInstanceIdentityProof } from "../domain/automationInstanceIdentity"
import type { AutomationWorkerIdentity } from "./automation"

const mocks = vi.hoisted(() => ({
  discover: vi.fn(), read: vi.fn(), activate: vi.fn(),
}))
vi.mock("./automationInstanceClient", () => ({
  discoverAutomationInstance: mocks.discover,
  readAutomationInstance: mocks.read,
  activateExistingAutomation: mocks.activate,
}))

import { inspectExistingAutomation, reactivateExistingAutomation } from "./automationInstanceManagement"

const origin = "https://automation.example.test"
const workspaceId = "workspace-1"
const definitionId = "typed-definition"
const integrationId = "legacy-route"
let owner: LocalProfile
let description: AutomationInstanceDescription
let identity: AutomationInstanceIdentityPayload
let proof: AutomationInstanceIdentityProof

beforeEach(async () => {
  resetIdentityStorageForTest()
  owner = await bootstrapIdentity("Instance manager")
  description = { workspaceId, boardId: "board-1", definitionId, executorPersonId: owner.identity.personId,
    grantId: "expired-grant", expiresAt: Date.now() + 60_000, state: "paused", adoptionRequired: false }
  identity = { kind: "automation-instance-identity", version: 1, origin, workspaceId, definitionId, integrationId,
    executorPersonId: owner.identity.personId, deviceId: owner.device.deviceId, requestNonce: crypto.randomUUID(),
    issuedAt: Date.now(), description }
  proof = { publicKey: owner.identity.publicKey, certificates: [owner.certificate], signed: {
    signerKeyId: owner.device.deviceId, signature: "verified-by-adapter", payload: identity,
  } }
  mocks.discover.mockReset().mockResolvedValue({ integrationId })
  mocks.read.mockReset().mockResolvedValue({ proof, identity })
  mocks.activate.mockReset().mockResolvedValue(undefined)
})

afterEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })

function packet(overrides: Record<string, unknown> = {}) {
  return { version: 2, workspaceId, definition: { payload: { id: definitionId } },
    grant: { payload: { personId: owner.identity.personId } }, ...overrides }
}

describe("automation instance management adapter", () => {
  it("Given a distinct Worker route and typed definition, When inspecting, Then preserve route, intended ID and verified leaf identity", async () => {
    const result = await inspectExistingAutomation(owner, { origin, workspaceId, definitionId, executorPersonId: owner.identity.personId })
    expect(mocks.discover).toHaveBeenCalledWith(owner, { origin, workspaceId, definitionId, executorPersonId: owner.identity.personId }, undefined)
    expect(mocks.read).toHaveBeenCalledWith(owner, { origin, workspaceId, definitionId,
      executorPersonId: owner.identity.personId, integrationId }, undefined)
    expect(result.description).toEqual(description)
    expect(result.identity).toEqual({ integrationId, definitionId, origin, personId: owner.identity.personId,
      identityPublicKey: owner.identity.publicKey, deviceId: owner.device.deviceId, devicePublicKey: owner.device.publicKey,
      deviceCertificate: owner.certificate } satisfies AutomationWorkerIdentity)
  })

  it("Given an existing valid approval, When explicitly reactivating, Then send the exact workspace and definition packet", async () => {
    const inspected = await inspectExistingAutomation(owner, { origin, workspaceId, definitionId, executorPersonId: owner.identity.personId })
    await reactivateExistingAutomation(owner, inspected, { workspaceId, packet: packet(), explicitApproval: false })
    expect(mocks.activate).toHaveBeenCalledWith(owner, { origin, workspaceId, definitionId,
      executorPersonId: owner.identity.personId, integrationId, packet: packet(), adoptLegacy: false }, undefined)
  })

  it("Given legacy adoption or expired grant, When approval is absent, Then stop before Worker activation", async () => {
    const inspected = await inspectExistingAutomation(owner, { origin, workspaceId, definitionId, executorPersonId: owner.identity.personId })
    const legacy = { ...inspected, description: { ...description, definitionId: null, adoptionRequired: true } }
    await expect(reactivateExistingAutomation(owner, legacy, { workspaceId, packet: packet(), explicitApproval: false }))
      .rejects.toThrow(/explicit approval/i)
    const expired = { ...inspected, description: { ...description, expiresAt: Date.now() - 1 } }
    await expect(reactivateExistingAutomation(owner, expired, { workspaceId, packet: packet(), explicitApproval: false }))
      .rejects.toThrow(/explicit approval/i)
    expect(mocks.activate).not.toHaveBeenCalled()
    await reactivateExistingAutomation(owner, legacy, { workspaceId, packet: packet(), explicitApproval: true })
    expect(mocks.activate).toHaveBeenCalledWith(owner, expect.objectContaining({ adoptLegacy: true }), undefined)
  })

  it("Given a packet for another instance, workspace, or person, When reactivating, Then reject before network", async () => {
    const inspected = await inspectExistingAutomation(owner, { origin, workspaceId, definitionId, executorPersonId: owner.identity.personId })
    for (const wrong of [packet({ version: 1 }), packet({ workspaceId: "other-workspace" }),
      packet({ definition: { payload: { id: "other-definition" } } }),
      packet({ grant: { payload: { personId: "other-person" } } })]) {
      await expect(reactivateExistingAutomation(owner, inspected, { workspaceId, packet: wrong, explicitApproval: true })).rejects.toThrow()
    }
    expect(mocks.activate).not.toHaveBeenCalled()
  })

  it("Given identity changes during inspection, When a route response arrives, Then do not return stale worker identity", async () => {
    let current = true
    const guards = { ensureCurrent: () => { if (!current) throw new Error("identity changed") } }
    mocks.read.mockImplementation(async () => { current = false; return { proof, identity } })
    await expect(inspectExistingAutomation(owner, { origin, workspaceId, definitionId, executorPersonId: owner.identity.personId }, guards))
      .rejects.toThrow(/identity changed/i)
  })
})
