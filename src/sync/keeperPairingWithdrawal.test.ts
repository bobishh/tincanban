import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  pendingKeeperWithdrawal: vi.fn(),
  savePendingKeeperWithdrawal: vi.fn(),
  savePendingKeeperWithdrawalProofs: vi.fn(),
  clearPendingKeeperWithdrawalProofs: vi.fn(),
  getKeeperPairingStatusInfo: vi.fn(),
  requestKeeperPairingWithdrawal: vi.fn(),
  completeKeeperPairingWithdrawal: vi.fn(),
  getKeeperIntegrationStatus: vi.fn(),
  disconnectKeeperIntegration: vi.fn(),
}))

vi.mock("./ownerKeeper", () => ({
  pendingKeeperWithdrawal: mocks.pendingKeeperWithdrawal,
  savePendingKeeperWithdrawal: mocks.savePendingKeeperWithdrawal,
  savePendingKeeperWithdrawalProofs: mocks.savePendingKeeperWithdrawalProofs,
  clearPendingKeeperWithdrawalProofs: mocks.clearPendingKeeperWithdrawalProofs,
}))
vi.mock("./keeperPairingWithdrawalApi", () => ({
  getKeeperPairingStatusInfo: mocks.getKeeperPairingStatusInfo,
  requestKeeperPairingWithdrawal: mocks.requestKeeperPairingWithdrawal,
  completeKeeperPairingWithdrawal: mocks.completeKeeperPairingWithdrawal,
}))
vi.mock("./keeperPairing", () => ({
  getKeeperIntegrationStatus: mocks.getKeeperIntegrationStatus,
  disconnectKeeperIntegration: mocks.disconnectKeeperIntegration,
}))

import type { DurableMesh } from "./durableMesh"
import type { KeeperPairing } from "./keeperPairing"
import { cancelKeeperPairing } from "./keeperPairingWithdrawal"

const discovery = { origin: "https://rusty.example", personId: "rusty-person" }
const pairing = { pairingId: "pairing-a", integrationId: "integration-a", discovery,
  workspaces: [{ id: "board-a", title: "Board A" }] } as KeeperPairing
const proof = { workspaceId: "board-a", document: "signed-board-state", authorizationBundle: { bundle: true },
  grant: { workspaceId: "board-a", role: "editor" } }
const pendingWithdrawal = { status: "cancel_pending", requestHash: "withdrawal-hash", operationId: "withdraw-op" }

type TestMesh = DurableMesh & {
  captureKeeperGrantScopeProofs: ReturnType<typeof vi.fn>
  revokePerson: ReturnType<typeof vi.fn>
  captureRevocationCompletionScopes: ReturnType<typeof vi.fn>
}

function mesh(): TestMesh {
  return {
    captureKeeperGrantScopeProofs: vi.fn(async () => [proof]),
    revokePerson: vi.fn(async () => undefined),
    captureRevocationCompletionScopes: vi.fn(async () => [{ workspaceId: "board-a", document: "revoked-state",
      authorizationBundle: { revoked: true } }]),
  } as unknown as TestMesh
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.pendingKeeperWithdrawal.mockResolvedValue({ grantScopes: [proof] })
  mocks.savePendingKeeperWithdrawalProofs.mockImplementation(async (_pairing, _operation, grantScopes) => ({ grantScopes }))
  mocks.requestKeeperPairingWithdrawal.mockResolvedValue(pendingWithdrawal)
  mocks.getKeeperPairingStatusInfo.mockResolvedValue({ status: "cancel_pending", provisioningScopes: [
    { workspaceId: "board-a", status: "active", grantEpoch: 9 },
  ] })
  mocks.getKeeperIntegrationStatus.mockResolvedValue({ revision: 4, integrations: [{ integrationId: "integration-a",
    revision: 2, scopes: [{ workspaceId: "board-a", grantEpoch: 9 }], tombstones: [] }] })
  mocks.disconnectKeeperIntegration.mockResolvedValue({ status: "removed" })
  mocks.completeKeeperPairingWithdrawal.mockResolvedValue({ status: "cancelled" })
})

describe("keeper pairing cancellation", () => {
  it("persists proof, revokes exact issued grants, and waits for signed cleanup", async () => {
    mocks.pendingKeeperWithdrawal.mockResolvedValueOnce(undefined)
    const boardMesh = mesh()
    const result = await cancelKeeperPairing(pairing, "withdraw-op", async () => boardMesh)

    expect(result).toBe("cancelled")
    expect(mocks.savePendingKeeperWithdrawal).toHaveBeenCalledWith("pairing-a", "withdraw-op", expect.objectContaining({ pairingId: "pairing-a" }))
    expect(boardMesh.captureKeeperGrantScopeProofs).toHaveBeenCalledWith(["board-a"], "rusty-person")
    expect(mocks.savePendingKeeperWithdrawalProofs).toHaveBeenCalledWith("pairing-a", "withdraw-op", [proof])
    expect(boardMesh.revokePerson).toHaveBeenCalledWith("board-a", "rusty-person", 9)
    expect(mocks.disconnectKeeperIntegration).toHaveBeenCalledWith(discovery, "integration-a", 2, "withdraw-op",
      [{ workspaceId: "board-a", expectedGrantEpoch: 9 }], undefined)
    expect(mocks.completeKeeperPairingWithdrawal).toHaveBeenCalledWith(pairing, "withdraw-op", expect.any(Array), "withdrawal-hash")
    expect(mocks.clearPendingKeeperWithdrawalProofs).toHaveBeenCalledWith("pairing-a", "withdraw-op")
  })

  it("uses the target integration revision, not max revision from unrelated history", async () => {
    const boardMesh = mesh()
    mocks.getKeeperIntegrationStatus.mockResolvedValueOnce({ revision: 7, integrations: [
      { integrationId: "integration-a", revision: 2, scopes: [{ workspaceId: "board-a", grantEpoch: 9 }], tombstones: [] },
      { integrationId: "other-integration", revision: 7, scopes: [], tombstones: [] },
    ] })
    await cancelKeeperPairing(pairing, "withdraw-op", async () => boardMesh)
    expect(mocks.disconnectKeeperIntegration).toHaveBeenCalledWith(discovery, "integration-a", 2, "withdraw-op",
      [{ workspaceId: "board-a", expectedGrantEpoch: 9 }], undefined)
  })

  it("keeps intent pending when Rusty has not proved a grant epoch or cleanup", async () => {
    const boardMesh = mesh()
    mocks.getKeeperPairingStatusInfo.mockResolvedValueOnce({ status: "cancel_pending", provisioningScopes: [
      { workspaceId: "board-a", status: "pending" },
    ] })
    await expect(cancelKeeperPairing(pairing, "withdraw-op", async () => boardMesh)).resolves.toBe("cancel_pending")
    expect(boardMesh.revokePerson).not.toHaveBeenCalled()
    expect(mocks.disconnectKeeperIntegration).not.toHaveBeenCalled()
    expect(mocks.completeKeeperPairingWithdrawal).not.toHaveBeenCalled()

    mocks.getKeeperPairingStatusInfo.mockResolvedValueOnce({ status: "cancel_pending", provisioningScopes: [
      { workspaceId: "board-a", status: "active", grantEpoch: 9 },
    ] })
    mocks.disconnectKeeperIntegration.mockResolvedValueOnce({ status: "pending" })
    await expect(cancelKeeperPairing(pairing, "withdraw-op", async () => boardMesh)).resolves.toBe("cancel_pending")
    expect(mocks.completeKeeperPairingWithdrawal).not.toHaveBeenCalled()
  })

  it("rejects cleanup for another operation, an unapproved board, or a newer board grant", async () => {
    const boardMesh = mesh()
    mocks.getKeeperIntegrationStatus.mockResolvedValueOnce({ revision: 4, integrations: [{ integrationId: "integration-a",
      revision: 4, pendingOperation: { operationId: "other-op", scopes: [{ workspaceId: "board-a", expectedGrantEpoch: 9 }] },
      scopes: [], tombstones: [] }] })
    await expect(cancelKeeperPairing(pairing, "withdraw-op", async () => boardMesh)).rejects.toThrow("another board cleanup pending")

    mocks.getKeeperIntegrationStatus.mockResolvedValueOnce({ revision: 4, integrations: [{ integrationId: "integration-a",
      revision: 4, pendingOperation: { operationId: "withdraw-op", scopes: [{ workspaceId: "other-board", expectedGrantEpoch: 9 }] },
      scopes: [], tombstones: [] }] })
    await expect(cancelKeeperPairing(pairing, "withdraw-op", async () => boardMesh)).rejects.toThrow("outside this approved request")

    mocks.getKeeperIntegrationStatus.mockResolvedValueOnce({ revision: 4, integrations: [{ integrationId: "integration-a",
      revision: 4, scopes: [{ workspaceId: "board-a", grantEpoch: 10 }], tombstones: [] }] })
    await expect(cancelKeeperPairing(pairing, "withdraw-op", async () => boardMesh)).rejects.toThrow("newer board grant")
    expect(boardMesh.revokePerson).toHaveBeenCalledTimes(3)
  })
})
