import { beforeEach, describe, expect, it, vi } from "vitest"
import type { KeeperPairing, KeeperWithdrawalGrantProof, KeeperWithdrawalScopeProof } from "./keeperPairing"

const mocks = vi.hoisted(() => ({
  bootstrapIdentity: vi.fn(),
  canonicalizeJson: vi.fn((value: unknown) => JSON.stringify(value)),
  sha256Base64Url: vi.fn(async () => "request-hash"),
  requestKeeperJson: vi.fn(),
  signKeeperControllerRequest: vi.fn(),
  verifyKeeperServiceEnvelope: vi.fn(),
  verifyProvisionedScopes: vi.fn(),
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
  verifyProvisionedScopes: mocks.verifyProvisionedScopes,
}))

import { completeKeeperPairingWithdrawal, getKeeperPairingStatusInfo, requestKeeperPairingWithdrawal } from "./keeperPairingWithdrawalApi"

const discovery = {
  origin: "https://rusty.example",
  displayName: "Rusty",
  personId: "service-person",
  publicKey: "service-key",
  deviceId: "service-device",
  certificates: [],
  fingerprint: "service-fingerprint",
  capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: true, pairing: true },
}
const pairing = {
  pairingId: "pairing-1",
  integrationId: "integration-1",
  operatorUrl: "https://rusty.example/admin",
  comparisonCode: "123456",
  expiresAt: 500,
  transcriptHash: "transcript-1",
  challengeNonce: "nonce-1",
  controllerFingerprint: "controller-fingerprint",
  discovery,
  workspaces: [{ id: "board-a", title: "A" }, { id: "board-b", title: "B" }],
} as KeeperPairing
const grantScopes: KeeperWithdrawalGrantProof[] = pairing.workspaces.map(workspace => ({
  workspaceId: workspace.id,
  document: `document-${workspace.id}`,
  authorizationBundle: { workspaceId: workspace.id },
  grant: { workspaceId: workspace.id, role: "editor" },
}))
const completionScopes: KeeperWithdrawalScopeProof[] = grantScopes.map(({ workspaceId, document, authorizationBundle }) => ({
  workspaceId, document, authorizationBundle,
}))

function statusPayload(status: string, withdrawal?: unknown, provisioning?: unknown) {
  return {
    pairingId: pairing.pairingId,
    integrationId: pairing.integrationId,
    transcriptHash: pairing.transcriptHash,
    serviceOrigin: discovery.origin,
    status,
    ...(withdrawal !== undefined ? { withdrawal } : {}),
    ...(provisioning !== undefined ? { provisioning } : {}),
  }
}

function receipt(status: "cancel_pending" | "cancelled", operationId = "op-1", requestHash = "request-hash") {
  return statusPayload(status, { operationId, requestHash, status })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.bootstrapIdentity.mockResolvedValue({ identity: { personId: "owner-person" } })
  mocks.signKeeperControllerRequest.mockImplementation(async (_profile, _discovery, kind, body) => ({
    signed: { payload: { ...body, kind, issuedAt: 10, expiresAt: 20 } },
  }))
  mocks.requestKeeperJson.mockResolvedValue({ signed: "service-envelope" })
  mocks.verifyKeeperServiceEnvelope.mockResolvedValue(statusPayload("cancel_pending"))
  mocks.verifyProvisionedScopes.mockReturnValue([])
})

describe("signed keeper pairing withdrawal API", () => {
  it("accepts a bound pending status and returns verified provisioned scopes", async () => {
    const scopes = [{ workspaceId: "board-a", status: "pending" as const, grantEpoch: 3 }]
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(statusPayload("cancel_pending", {
      operationId: "op-1", requestHash: "request-hash", status: "cancel_pending",
    }, { scopes: true }))
    mocks.verifyProvisionedScopes.mockReturnValue(scopes)

    const result = await getKeeperPairingStatusInfo(pairing, "op-1")

    expect(result).toEqual({ status: "cancel_pending", withdrawal: {
      operationId: "op-1", requestHash: "request-hash", status: "cancel_pending",
    }, provisioningScopes: scopes })
    expect(mocks.signKeeperControllerRequest).toHaveBeenCalledWith(expect.anything(), discovery,
      "keeper-pairing-status", { pairingId: "pairing-1", transcriptHash: "transcript-1", withdrawalOperationId: "op-1" })
    expect(mocks.verifyProvisionedScopes).toHaveBeenCalledWith(expect.any(Object), pairing, true)
  })

  it("accepts non-cancellation status without a withdrawal and omits false provisioning", async () => {
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(statusPayload("approved", null, false))

    await expect(getKeeperPairingStatusInfo(pairing)).resolves.toEqual({ status: "approved" })
    expect(mocks.verifyProvisionedScopes).not.toHaveBeenCalled()
  })

  it("rejects status belonging to another service pairing or origin", async () => {
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue({ ...statusPayload("approved"), pairingId: "other" })
    await expect(getKeeperPairingStatusInfo(pairing)).rejects.toThrow("another pairing")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue({ ...statusPayload("approved"), serviceOrigin: "https://other.example" })
    await expect(getKeeperPairingStatusInfo(pairing)).rejects.toThrow("another pairing")
  })

  it("rejects unsupported, malformed, or differently bound cancellation states", async () => {
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(statusPayload("unknown"))
    await expect(getKeeperPairingStatusInfo(pairing)).rejects.toThrow("unsupported state")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(statusPayload("cancel_pending", { operationId: "", requestHash: "h", status: "cancel_pending" }))
    await expect(getKeeperPairingStatusInfo(pairing)).rejects.toThrow("malformed cancellation status")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(statusPayload("cancel_pending", { operationId: "other", requestHash: "h", status: "cancel_pending" }))
    await expect(getKeeperPairingStatusInfo(pairing, "op-1")).rejects.toThrow("malformed cancellation status")
  })

  it("rejects status/withdrawal disagreement and active scopes in terminal cancellation", async () => {
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(statusPayload("approved", { operationId: "op-1", requestHash: "h", status: "cancel_pending" }))
    await expect(getKeeperPairingStatusInfo(pairing)).rejects.toThrow("does not match")
    mocks.verifyProvisionedScopes.mockReturnValue([{ workspaceId: "board-a", status: "active" }])
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(statusPayload("cancelled", { operationId: "op-1", requestHash: "h", status: "cancelled" }, { scopes: true }))
    await expect(getKeeperPairingStatusInfo(pairing)).rejects.toThrow("before every board was detached")
  })

  it("signs exact approved grant proofs and accepts a matching pending receipt", async () => {
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(receipt("cancel_pending"))

    await expect(requestKeeperPairingWithdrawal(pairing, "op-1", grantScopes)).resolves.toEqual({
      operationId: "op-1", requestHash: "request-hash", status: "cancel_pending",
    })
    expect(mocks.signKeeperControllerRequest).toHaveBeenCalledWith(expect.anything(), discovery,
      "keeper-pairing-withdrawal", expect.objectContaining({
        pairingId: "pairing-1", transcriptHash: "transcript-1", challengeNonce: "nonce-1",
        operationId: "op-1", servicePersonId: "service-person", serviceDeviceId: "service-device",
        serviceOrigin: "https://rusty.example", grantScopes,
      }))
    expect(mocks.requestKeeperJson).toHaveBeenCalledWith("https://rusty.example/v1/pairings/pairing-1/withdraw",
      expect.objectContaining({ method: "POST" }))
  })

  it("rejects duplicate or unapproved grant proofs before sending a request", async () => {
    const duplicate = [grantScopes[0]!, { ...grantScopes[0]! }]
    await expect(requestKeeperPairingWithdrawal(pairing, "op-1", duplicate)).rejects.toThrow("unapproved board")
    await expect(requestKeeperPairingWithdrawal(pairing, "op-1", [{ ...grantScopes[0]!, workspaceId: "foreign" }]))
      .rejects.toThrow("unapproved board")
    expect(mocks.requestKeeperJson).not.toHaveBeenCalled()
  })

  it("rejects a receipt for another operation, hash, pairing, or non-cancellation state", async () => {
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(receipt("cancel_pending", "other"))
    await expect(requestKeeperPairingWithdrawal(pairing, "op-1")).rejects.toThrow("malformed cancellation status")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(receipt("cancel_pending", "op-1", "other-hash"))
    await expect(requestKeeperPairingWithdrawal(pairing, "op-1")).rejects.toThrow("another request")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue({ ...receipt("cancel_pending"), pairingId: "other" })
    await expect(requestKeeperPairingWithdrawal(pairing, "op-1")).rejects.toThrow("another request")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(statusPayload("cancel_pending", {
      operationId: "op-1", requestHash: "request-hash", status: "cancelled",
    }))
    await expect(requestKeeperPairingWithdrawal(pairing, "op-1")).rejects.toThrow("another request")
  })

  it("completes only the exact approved scope set and binds the receipt hash", async () => {
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(receipt("cancelled"))

    await expect(completeKeeperPairingWithdrawal(pairing, "op-1", completionScopes, "request-hash")).resolves.toEqual({
      operationId: "op-1", requestHash: "request-hash", status: "cancelled",
    })
    expect(mocks.signKeeperControllerRequest).toHaveBeenCalledWith(expect.anything(), discovery,
      "keeper-pairing-withdrawal-complete", expect.objectContaining({
        pairingId: "pairing-1", withdrawalOperationId: "op-1", operationId: "op-1",
        transcriptHash: "transcript-1", challengeNonce: "nonce-1", scopes: completionScopes,
      }))
    expect(mocks.requestKeeperJson).toHaveBeenCalledWith("https://rusty.example/v1/pairings/pairing-1/withdraw/complete",
      expect.objectContaining({ method: "POST" }))
  })

  it("rejects incomplete, duplicate, or extra completion scope proofs before sending", async () => {
    await expect(completeKeeperPairingWithdrawal(pairing, "op-1", [completionScopes[0]!])).rejects.toThrow("exact approved boards")
    await expect(completeKeeperPairingWithdrawal(pairing, "op-1", [completionScopes[0]!, { ...completionScopes[0]! }]))
      .rejects.toThrow("exact approved boards")
    await expect(completeKeeperPairingWithdrawal(pairing, "op-1", [...completionScopes, {
      ...completionScopes[0]!, workspaceId: "foreign",
    }])).rejects.toThrow("exact approved boards")
    expect(mocks.requestKeeperJson).not.toHaveBeenCalled()
  })

  it("rejects completion receipts that mismatch cancellation state or original request hash", async () => {
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(receipt("cancel_pending"))
    await expect(completeKeeperPairingWithdrawal(pairing, "op-1", completionScopes, "request-hash"))
      .resolves.toMatchObject({ status: "cancel_pending" })
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(statusPayload("cancelled", {
      operationId: "op-1", requestHash: "request-hash", status: "cancel_pending",
    }))
    await expect(completeKeeperPairingWithdrawal(pairing, "op-1", completionScopes))
      .rejects.toThrow("invalid cancellation completion")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(receipt("cancelled", "other"))
    await expect(completeKeeperPairingWithdrawal(pairing, "op-1", completionScopes)).rejects.toThrow("malformed cancellation status")
    mocks.verifyKeeperServiceEnvelope.mockResolvedValue(receipt("cancelled", "op-1", "other-hash"))
    await expect(completeKeeperPairingWithdrawal(pairing, "op-1", completionScopes, "request-hash"))
      .rejects.toThrow("invalid cancellation completion")
  })
})
