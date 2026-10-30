import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  bootstrapIdentity: vi.fn(),
  canonicalizeJson: vi.fn((value: unknown) => JSON.stringify(value)),
  sha256Base64Url: vi.fn(async () => "request-hash"),
  requestKeeperJson: vi.fn(),
  signKeeperControllerRequest: vi.fn(),
  verifyKeeperServiceEnvelope: vi.fn(),
}))

vi.mock("../domain/identity", () => ({
  bootstrapIdentity: mocks.bootstrapIdentity,
  canonicalizeJson: mocks.canonicalizeJson,
  sha256Base64Url: mocks.sha256Base64Url,
}))
vi.mock("./keeperPairing", () => ({
  requestKeeperJson: mocks.requestKeeperJson,
  signKeeperControllerRequest: mocks.signKeeperControllerRequest,
  verifyKeeperServiceEnvelope: mocks.verifyKeeperServiceEnvelope,
}))

import type { KeeperDiscovery } from "./keeperDiscovery"
import { keeperIntegrationSettingsRequestHash, updateKeeperIntegrationSettings } from "./keeperIntegrationSettingsApi"

const discovery: KeeperDiscovery = {
  origin: "https://rusty.example", displayName: "Rusty", personId: "service-person",
  deviceId: "service-device", publicKey: "service-key", certificates: [], fingerprint: "fingerprint",
  capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: true, pairing: true },
}
const scopes = [{ workspaceId: "board-a", expectedGrantEpoch: 7 }]

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    version: 1, integrationId: "integration-a", operationId: "settings-op", requestHash: "request-hash",
    controllerPersonId: "owner-person", controllerDeviceId: "owner-device", revision: 3, status: "updated",
    policy: { futureBoards: false, baselineWorkspaceIds: ["board-a", "retained-board"] },
    scopes: [{ workspaceId: "board-a", grantEpoch: 7, state: "removed", cleanup: "complete" }],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.bootstrapIdentity.mockResolvedValue({ identity: { personId: "owner-person" }, device: { deviceId: "owner-device" } })
  mocks.signKeeperControllerRequest.mockImplementation(async (_profile, _discovery, kind, body) => ({
    signed: { payload: { ...body, kind, issuedAt: 10, expiresAt: 20 } },
  }))
  mocks.requestKeeperJson.mockResolvedValue({ service: "response" })
  mocks.verifyKeeperServiceEnvelope.mockImplementation(async (_discovery, _response, kind) => {
    expect(kind).toBe("keeper-integration-settings-receipt")
    return receipt()
  })
})

describe("signed keeper integration settings API", () => {
  it("sends revision-bound intent and accepts exact signed cleanup receipt", async () => {
    await expect(updateKeeperIntegrationSettings(discovery, "integration-a", 2, "settings-op", scopes, false,
      "request-hash")).resolves.toMatchObject({
      integrationId: "integration-a", operationId: "settings-op", revision: 3, status: "updated",
      futureBoards: false, baselineWorkspaceIds: ["board-a", "retained-board"],
      scopes: [{ workspaceId: "board-a", grantEpoch: 7, state: "removed", cleanup: "complete" }],
    })
    expect(mocks.signKeeperControllerRequest).toHaveBeenCalledWith(expect.anything(), discovery,
      "keeper-integration-settings", expect.objectContaining({ integrationId: "integration-a", expectedRevision: 2,
        operationId: "settings-op", policy: { futureBoards: false }, scopes }))
    expect(mocks.requestKeeperJson).toHaveBeenCalledWith("https://rusty.example/v1/integrations/integration-a/settings",
      expect.objectContaining({ method: "POST" }))
    await expect(keeperIntegrationSettingsRequestHash(discovery, "integration-a", 2, "settings-op", scopes, false))
      .resolves.toBe("request-hash")
  })

  it("rejects malformed or duplicate board requests before sending them", async () => {
    await expect(updateKeeperIntegrationSettings(discovery, "", 2, "op", scopes, false)).rejects.toThrow("request is invalid")
    await expect(updateKeeperIntegrationSettings(discovery, "integration-a", -1, "op", scopes, false)).rejects.toThrow("request is invalid")
    await expect(updateKeeperIntegrationSettings(discovery, "integration-a", 2, "op",
      [...scopes, scopes[0]!], false)).rejects.toThrow("request is invalid")
    await expect(updateKeeperIntegrationSettings(discovery, "integration-a", 2, "op",
      [{ workspaceId: "board-a", expectedGrantEpoch: 0 }], false)).rejects.toThrow("request is invalid")
    expect(mocks.requestKeeperJson).not.toHaveBeenCalled()
  })

  it("rejects receipts that change saved intent, exact boards, or cleanup outcome", async () => {
    await expect(updateKeeperIntegrationSettings(discovery, "integration-a", 2, "settings-op", scopes, false,
      "different-hash")).rejects.toThrow("differ from saved intent")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValueOnce(receipt({ integrationId: "other-integration" }))
    await expect(updateKeeperIntegrationSettings(discovery, "integration-a", 2, "settings-op", scopes, false))
      .rejects.toThrow("receipt for different keeper settings")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValueOnce(receipt({ scopes: [] }))
    await expect(updateKeeperIntegrationSettings(discovery, "integration-a", 2, "settings-op", scopes, false))
      .rejects.toThrow("does not match exact requested boards")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValueOnce(receipt({ scopes: [{ workspaceId: "board-a", grantEpoch: 7,
      state: "pending", cleanup: "pending" }] }))
    await expect(updateKeeperIntegrationSettings(discovery, "integration-a", 2, "settings-op", scopes, false))
      .rejects.toThrow("before cleanup completed")
  })

  it("rejects malformed signed scope and baseline details", async () => {
    mocks.verifyKeeperServiceEnvelope.mockResolvedValueOnce(receipt({ scopes: [{ workspaceId: "board-a",
      grantEpoch: "7", state: "removed", cleanup: "complete" }] }))
    await expect(updateKeeperIntegrationSettings(discovery, "integration-a", 2, "settings-op", scopes, false))
      .rejects.toThrow("malformed keeper settings scope state")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValueOnce(receipt({ policy: { futureBoards: false, baselineWorkspaceIds: [4] } }))
    await expect(updateKeeperIntegrationSettings(discovery, "integration-a", 2, "settings-op", scopes, false))
      .rejects.toThrow("malformed keeper settings baseline")
  })
})
