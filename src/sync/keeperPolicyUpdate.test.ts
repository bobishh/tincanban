import { beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { canonicalKeeperIntegrationId } from "./keeperIntegrationSelection"

const mocks = vi.hoisted(() => ({
  keeperIntegrationReferences: vi.fn(),
  discoverKeeper: vi.fn(),
  getKeeperIntegrationStatus: vi.fn(),
  beginKeeperPairing: vi.fn(),
}))

vi.mock("./ownerKeeper", () => ({ keeperIntegrationReferences: mocks.keeperIntegrationReferences }))
vi.mock("./keeperDiscovery", () => ({ discoverKeeper: mocks.discoverKeeper }))
vi.mock("./keeperPairing", () => ({
  getKeeperIntegrationStatus: mocks.getKeeperIntegrationStatus,
  beginKeeperPairing: mocks.beginKeeperPairing,
}))

import { beginKeeperPolicyUpdate } from "./keeperPolicyUpdate"

const reference = { integrationId: "", serviceOrigin: "https://rusty.example",
  servicePersonId: "rusty-person", state: "active" }
const discovery = { origin: "https://rusty.example", personId: "rusty-person" }
const active = { integrationId: "", futureBoards: false, scopes: [
  { workspaceId: "active-board", grantEpoch: 3, state: "active" as const },
], tombstones: [{ workspaceId: "removed-board", grantEpoch: 2, state: "removed" as const }] }
const pairing = { pairingId: "settings-pairing" }

beforeEach(async () => {
  vi.clearAllMocks()
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Policy owner")
  const integrationId = await canonicalKeeperIntegrationId(profile.identity.personId, discovery.personId)
  reference.integrationId = integrationId
  active.integrationId = integrationId
  mocks.keeperIntegrationReferences.mockResolvedValue({ integrations: { [integrationId]: reference } })
  mocks.discoverKeeper.mockResolvedValue(discovery)
  mocks.getKeeperIntegrationStatus.mockResolvedValue({ integrations: [active] })
  mocks.beginKeeperPairing.mockResolvedValue(pairing)
})

describe("future-board policy approval", () => {
  it("requests policy-only owner and operator approval with complete owned-board baseline", async () => {
    await expect(beginKeeperPolicyUpdate("rusty-person", ["newly-owned", "active-board", "newly-owned"]))
      .resolves.toBe(pairing)
    expect(mocks.beginKeeperPairing).toHaveBeenCalledWith(discovery, [], {
      futureBoards: true, futureBoardBaselineIds: ["active-board", "newly-owned", "removed-board"], policyOnly: true,
    })
  })

  it("requires saved active integration and rejects pending or already-enabled service state", async () => {
    mocks.keeperIntegrationReferences.mockResolvedValueOnce({ integrations: {} })
    await expect(beginKeeperPolicyUpdate("rusty-person", [])).rejects.toThrow("could not be verified")
    mocks.getKeeperIntegrationStatus.mockResolvedValueOnce({ integrations: [] })
    await expect(beginKeeperPolicyUpdate("rusty-person", [])).rejects.toThrow("changed or has cleanup pending")
    mocks.getKeeperIntegrationStatus.mockResolvedValueOnce({ integrations: [{ ...active, pendingOperation: { operationId: "pending" } }] })
    await expect(beginKeeperPolicyUpdate("rusty-person", [])).rejects.toThrow("changed or has cleanup pending")
    mocks.getKeeperIntegrationStatus.mockResolvedValueOnce({ integrations: [{ ...active, futureBoards: true }] })
    await expect(beginKeeperPolicyUpdate("rusty-person", [])).rejects.toThrow("changed or has cleanup pending")
    expect(mocks.beginKeeperPairing).not.toHaveBeenCalled()
  })

  it("rejects multiple live saved references before discovering or changing settings", async () => {
    mocks.keeperIntegrationReferences.mockResolvedValueOnce({ integrations: {
      [reference.integrationId]: reference,
      duplicate: { ...reference, integrationId: "duplicate" },
    } })
    await expect(beginKeeperPolicyUpdate("rusty-person", [])).rejects.toThrow("Multiple saved Rusty integrations need review")
    expect(mocks.discoverKeeper).not.toHaveBeenCalled()
    expect(mocks.beginKeeperPairing).not.toHaveBeenCalled()
  })

  it("uses canonical live row when signed status also contains terminal legacy history", async () => {
    mocks.getKeeperIntegrationStatus.mockResolvedValueOnce({ integrations: [active, {
      integrationId: "random-legacy-id", revision: 99, futureBoards: false, scopes: [],
      tombstones: [{ workspaceId: "old-board", grantEpoch: 8, state: "removed", cleanup: "complete", operationId: "old-remove" }],
    }] })
    await expect(beginKeeperPolicyUpdate("rusty-person", [])).resolves.toBe(pairing)
  })
})
