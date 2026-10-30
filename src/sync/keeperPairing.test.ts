import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest"
import { BrowserIdentityStore } from "@meta-uber/mesh-identity"
import type { WorkspaceJoinInvitation } from "@meta-uber/mesh-pairing"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, verifyEnvelope, type LocalProfile } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import type { KeeperDiscovery } from "./keeperDiscovery"
import { peerStore } from "./peerStore"
import * as ownerKeeper from "./ownerKeeper"
import { canonicalKeeperIntegrationId } from "./keeperIntegrationSelection"
import { getKeeperPairingStatusInfo } from "./keeperPairingWithdrawalApi"
const getKeeperPairingStatus = async (pairing: KeeperPairing) => (await getKeeperPairingStatusInfo(pairing)).status
import { beginKeeperPairing, decideKeeperPairing, deliverKeeperInvitation, disconnectKeeperIntegration, getEligibleKeeperWorkspaces, getKeeperIntegrationStatus, rememberActiveKeeperIntegration, refreshKeeperGrantFloors, signKeeperControllerRequest, verifyKeeperServiceEnvelope, type KeeperPairing } from "./keeperPairing"

const domain = "MESH-LIGHTHOUSE/1"
const boards = [{ id: "board", title: "Board" }]
let owner: LocalProfile
let service: Awaited<ReturnType<BrowserIdentityStore["bootstrap"]>>
let discovery: KeeperDiscovery
let pairing: KeeperPairing
let fetchMock: MockInstance<typeof fetch>

async function envelope(kind: string, payload: Record<string, unknown> = {}) {
  const wirePayload = JSON.parse(JSON.stringify({ kind, ...payload })) as Record<string, unknown> & { kind: string }
  return signEnvelope(service.privateKeys.devicePrivateKey, wirePayload, service.device.deviceId, domain)
}
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}
function pairingPayload(status = "pending") {
  return { pairingId: pairing.pairingId, integrationId: pairing.integrationId, transcriptHash: pairing.transcriptHash,
    serviceOrigin: discovery.origin, status }
}
function integrationPayload(operationId: unknown) {
  return { operationId, controllerPersonId: owner.identity.personId, controllerDeviceId: owner.device.deviceId,
    servicePersonId: discovery.personId, serviceDeviceId: discovery.deviceId, serviceOrigin: discovery.origin, revision: 2,
    integrations: [{ integrationId: "integration", revision: 2, policy: { futureBoards: false, baselineWorkspaceIds: ["board"] },
      scopes: [{ workspaceId: "board", grantEpoch: 1, state: "active", activationOperationId: "activation" }], tombstones: [], pendingOperation: null }] }
}

beforeEach(async () => {
  resetIdentityStorageForTest()
  owner = await bootstrapIdentity("Owner")
  service = await new BrowserIdentityStore({ storageKey: `keeper-test-${crypto.randomUUID()}` }).bootstrap("Keeper")
  discovery = { origin: "https://keeper.example", displayName: "Keeper", personId: service.identity.personId,
    publicKey: service.identity.publicKey, deviceId: service.device.deviceId, certificates: [service.certificate], fingerprint: "fingerprint",
    capabilities: { modes: ["replicate"], documentReplication: true, chatReplication: true, blobReplication: true, pairing: true } }
  pairing = { discovery, workspaces: boards, pairingId: "pairing", integrationId: "integration", operatorUrl: `${discovery.origin}/admin/`,
    transcriptHash: "transcript", challengeNonce: "nonce", comparisonCode: "123456", controllerFingerprint: "fingerprint",
    expiresAt: Math.floor(Date.now() / 1000) + 600, futureBoards: false, futureBoardBaselineIds: ["board"] }
  vi.spyOn(defaultProofStore, "listCertificates").mockResolvedValue([owner.certificate, service.certificate])
  fetchMock = vi.spyOn(globalThis, "fetch")
})
afterEach(() => vi.restoreAllMocks())

async function ownedBoard() {
  const genesis = await signEnvelope(owner.privateKeys.devicePrivateKey, { kind: "scope-genesis", version: 1, scopeId: "board",
    creator: { personId: owner.identity.personId, publicKey: owner.identity.publicKey, certificates: [owner.certificate] }, controlEpoch: 1 }, owner.device.deviceId)
  const authority = { version: 1 as const, epoch: 1, workspaceId: "board", ownerPersonId: owner.identity.personId, ownerPublicKey: owner.identity.publicKey,
    ownerCertificates: [owner.certificate], scopeAuthoritySnapshot: { genesis, grants: [], grantIssuers: [], revocations: [], controlTransfers: [] }, updatedAt: new Date().toISOString() }
  vi.spyOn(peerStore, "getWorkspaceAuthority").mockResolvedValue(authority)
  vi.spyOn(peerStore, "getWorkspaceCredential").mockResolvedValue(null)
  return authority
}
async function offer(overrides: Record<string, unknown> = {}, challengeOverrides: Record<string, unknown> = {},
  integrations: Record<string, unknown>[] = [], settingsSupported = true) {
  await ownedBoard()
  fetchMock.mockImplementation(async (url, init) => {
    const request = JSON.parse(String(init?.body)) as { signed: { payload: Record<string, unknown> } }
    if (String(url).endsWith("/v1/integrations/status")) {
      return reply(await envelope("keeper-integration-status", {
        ...integrationPayload(request.signed.payload.operationId), integrations,
        capabilities: { integrationSettings: settingsSupported },
      }))
    }
    const transcriptHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(request.signed.payload)))
    return reply({ pairingId: "pairing", expiresAt: pairing.expiresAt, comparisonCode: "123456", transcriptHash,
      operatorUrl: `${discovery.origin}/admin/`, challenge: await envelope("keeper-pairing-challenge", {
        pairingId: "pairing", integrationId: integrations[0]?.integrationId ?? "integration", transcriptHash, servicePersonId: discovery.personId,
        serviceOrigin: discovery.origin, expiresAt: pairing.expiresAt, nonce: "nonce", ...challengeOverrides }), ...overrides })
  })
}

describe("keeper controller boundary", () => {
  it("signs service-bound requests with owner certificates and bounded timestamps", async () => {
    const request = await signKeeperControllerRequest(owner, discovery, "test-request", { version: 99, serviceOrigin: "https://attacker.example" })
    expect(request.certificates).toEqual([owner.certificate])
    expect(request.signed.payload).toMatchObject({ version: 1, protocolVersion: 1, serviceOrigin: discovery.origin, controllerPersonId: owner.identity.personId })
    expect(Number(request.signed.payload.expiresAt) - Number(request.signed.payload.issuedAt)).toBe(600)
    expect(await verifyEnvelope(request.signed, owner.certificate.payload.devicePublicKey, domain)).toBe(true)
  })
  it.each([{ issuedAt: 1, expiresAt: 1 }, { issuedAt: 1, expiresAt: 602 }, { issuedAt: 1.5, expiresAt: 2 }])("rejects invalid request lifetime %j", async body => {
    await expect(signKeeperControllerRequest(owner, discovery, "test", body)).rejects.toThrow("timestamps are invalid")
  })
  it("verifies actual service signature and rejects tampered payload", async () => {
    const signed = await envelope("challenge", { nonce: "nonce" })
    await expect(verifyKeeperServiceEnvelope(discovery, signed, "challenge")).resolves.toMatchObject({ nonce: "nonce" })
    signed.payload.nonce = "tampered"
    await expect(verifyKeeperServiceEnvelope(discovery, signed, "challenge")).rejects.toThrow("signature is invalid")
  })
  it.each([null, {}, { payload: { kind: "challenge" }, signerKeyId: "other", signature: "fake" }])("rejects malformed or foreign envelopes %j", async signed => {
    await expect(verifyKeeperServiceEnvelope(discovery, signed, "challenge")).rejects.toThrow(/invalid signed|advertised device/)
  })
  it("rejects wrong response kind and untrusted certificate chain", async () => {
    const signed = await envelope("challenge")
    await expect(verifyKeeperServiceEnvelope(discovery, signed, "other")).rejects.toThrow("advertised device")
    await expect(verifyKeeperServiceEnvelope({ ...discovery, certificates: [] }, signed, "challenge")).rejects.toThrow()
  })
})

describe("keeper pairing", () => {
  it("offers owner scopes and binds signed challenge to transcript", async () => {
    await offer()
    const result = await beginKeeperPairing(discovery, boards, { futureBoards: false, futureBoardBaselineIds: ["board"] })
    expect(result).toMatchObject({ pairingId: "pairing", integrationId: "integration", challengeNonce: "nonce", workspaces: boards })
    expect(result.controllerFingerprint).toMatch(/^(?:[0-9a-f]{4}:){5}[0-9a-f]{4}$/)
    expect(result.workspaces[0]).not.toBe(boards[0])
    await expect(getEligibleKeeperWorkspaces(boards)).resolves.toEqual(boards)
  })
  async function existingIntegration(workspaceId = "board") {
    return { integrationId: await canonicalKeeperIntegrationId(owner.identity.personId, discovery.personId), revision: 2,
      policy: { futureBoards: false, baselineWorkspaceIds: [workspaceId] },
      scopes: [{ workspaceId, grantEpoch: 4, state: "active", activationOperationId: "activation" }],
      tombstones: [], pendingOperation: null }
  }
  it("Given an existing service integration, when another owned board is selected, then approval binds the exact revision and board delta", async () => {
    const existing = await existingIntegration("other")
    await offer({}, {}, [existing])
    const result = await beginKeeperPairing(discovery, boards, { futureBoards: false, futureBoardBaselineIds: ["board", "other"] })
    expect(result.integrationUpdate).toEqual({ integrationId: existing.integrationId, expectedRevision: 2,
      scopeWorkspaceIds: ["board"], policy: { futureBoards: false, baselineWorkspaceIds: ["board", "other"] } })
    expect(result.serviceGrantFloors).toEqual({ board: 0 })
  })
  it("Given an active board, when selected again, then no duplicate pairing offer is sent", async () => {
    await offer({}, {}, [await existingIntegration()])
    await expect(beginKeeperPairing(discovery, boards, { futureBoards: false, futureBoardBaselineIds: ["board"] })).rejects.toThrow("already active")
    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith("/status"))).toBe(true)
  })
  it("Given canonical cleanup pending on another board, when adding access, then service cleanup blocks the offer", async () => {
    const existing = await existingIntegration()
    await offer({}, {}, [{ ...existing, scopes: [], tombstones: [{ workspaceId: "other", grantEpoch: 4,
      state: "pending", cleanup: "pending", operationId: "cleanup" }], pendingOperation: { operationId: "cleanup",
      requestHash: "hash", expectedRevision: 2, scopes: [{ workspaceId: "other", expectedGrantEpoch: 4 }], status: "pending" } }])
    await expect(beginKeeperPairing(discovery, boards, { futureBoards: false, futureBoardBaselineIds: ["board"] })).rejects.toThrow("cleanup pending")
  })
  it("Given existing access with future boards off, when owner approves only policy, then no workspace invitation is delivered", async () => {
    const existing = await existingIntegration()
    await offer({}, {}, [existing])
    const result = await beginKeeperPairing(discovery, [], { futureBoards: true, futureBoardBaselineIds: ["board"], policyOnly: true })
    expect(result.integrationUpdate).toMatchObject({ policyOnly: true, scopeWorkspaceIds: [], expectedRevision: 2 })
    fetchMock.mockResolvedValue(reply(await envelope("keeper-pairing-status", { pairingId: result.pairingId,
      integrationId: result.integrationId, transcriptHash: result.transcriptHash, serviceOrigin: discovery.origin,
      status: "active", provisioning: { scopes: [] } })))
    await expect(deliverKeeperInvitation(result)).resolves.toBe("active")
    const sent = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body)) as { signed: { payload: { body: Record<string, unknown> } } }
    expect(sent.signed.payload.body).toMatchObject({ policyOnly: true, approvedScopes: [], futureBoards: true })
    expect(sent.signed.payload.body).not.toHaveProperty("invitation")
  })
  it.each(["unsupported", "absent", "already-enabled", "disabled-request", "missing-baseline"])("rejects unsafe policy-only approval: %s", async scenario => {
    const existing = await existingIntegration()
    await offer({}, {}, scenario === "absent" ? [] : [{ ...existing,
      policy: { futureBoards: scenario === "already-enabled", baselineWorkspaceIds: ["board"] } }], scenario !== "unsupported")
    await expect(beginKeeperPairing(discovery, [], { futureBoards: scenario !== "disabled-request",
      futureBoardBaselineIds: scenario === "missing-baseline" ? [] : ["board"], policyOnly: true }))
      .rejects.toThrow(scenario === "missing-baseline" ? "active and previously removed" : "Policy-only approval requires")
  })
  it("Given prior removal floors, when refreshing, then local higher epochs survive and the target active grant is excluded", async () => {
    const existing = await existingIntegration()
    await offer({}, {}, [{ ...existing, tombstones: [{ workspaceId: "board", grantEpoch: 3,
      state: "removed", cleanup: "complete", operationId: "old" }] }])
    await expect(refreshKeeperGrantFloors(discovery, ["board", "unknown"], { board: 6 }, existing.integrationId))
      .resolves.toEqual({ board: 6, unknown: 0 })
  })
  it.each([true, false])("rejects inconsistent policy-only scope before delivery: %s", async empty => {
    const invalid = empty ? { ...pairing, workspaces: [] } : { ...pairing,
      integrationUpdate: { integrationId: "integration", expectedRevision: 2, scopeWorkspaceIds: [],
        policy: { futureBoards: true, baselineWorkspaceIds: [] }, policyOnly: true } }
    await expect(deliverKeeperInvitation(invalid, { invitationId: "invite" } as unknown as WorkspaceJoinInvitation)).rejects.toThrow("cannot include")
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([[], ["other"], ["board", "board"], ["board", ""]].map(baseline => ({ baseline })))("rejects invalid baseline $baseline before HTTP", async ({ baseline }) => {
    await expect(beginKeeperPairing(discovery, boards, { futureBoards: false, futureBoardBaselineIds: baseline })).rejects.toThrow("baseline")
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it("rejects absent boards and missing ownership proof", async () => {
    await expect(beginKeeperPairing(discovery, [], { futureBoards: false, futureBoardBaselineIds: [] })).rejects.toThrow("Choose at least")
    vi.spyOn(peerStore, "getWorkspaceAuthority").mockResolvedValue(null)
    vi.spyOn(peerStore, "getWorkspaceCredential").mockResolvedValue(null)
    await expect(getEligibleKeeperWorkspaces(boards)).resolves.toEqual([])
    await expect(beginKeeperPairing(discovery, boards, { futureBoards: false, futureBoardBaselineIds: ["board"] })).rejects.toThrow("Owner proof unavailable")
  })
  it("Given durable authority absent, when a valid credential remains, then only its owned board is eligible", async () => {
    const authority = await ownedBoard()
    vi.mocked(peerStore.getWorkspaceAuthority).mockResolvedValue(null)
    vi.mocked(peerStore.getWorkspaceCredential).mockResolvedValue({ ...authority, transportSecret: "secret" })
    await expect(getEligibleKeeperWorkspaces(boards)).resolves.toEqual(boards)
    vi.mocked(peerStore.getWorkspaceCredential).mockResolvedValue({ ...authority, transportSecret: "secret", ownerPersonId: "foreign" })
    await expect(getEligibleKeeperWorkspaces(boards)).resolves.toEqual([])
  })
  it("Given forged or mismatched genesis authority, when selecting a board, then owner pairing is rejected", async () => {
    await offer()
    const authority = await ownedBoard()
    vi.mocked(peerStore.getWorkspaceAuthority).mockResolvedValue({ ...authority, scopeAuthoritySnapshot: {
      ...authority.scopeAuthoritySnapshot, genesis: { ...authority.scopeAuthoritySnapshot.genesis, signature: "forged" } } })
    await expect(getEligibleKeeperWorkspaces(boards)).resolves.toEqual([])
    vi.mocked(peerStore.getWorkspaceAuthority).mockResolvedValue({ ...authority, ownerPublicKey: service.identity.publicKey })
    await expect(getEligibleKeeperWorkspaces(boards)).resolves.toEqual([])
    await expect(beginKeeperPairing(discovery, boards, { futureBoards: false, futureBoardBaselineIds: ["board"] })).rejects.toThrow("Owner proof unavailable")
  })
  it.each([{ transcriptHash: "foreign" }, { operatorUrl: "https://attacker.example/admin/" }, { operatorUrl: "bad-url" }])("rejects unsafe pairing response %j", async overrides => {
    await offer(overrides)
    await expect(beginKeeperPairing(discovery, boards, { futureBoards: false, futureBoardBaselineIds: ["board"] })).rejects.toThrow(/does not match|unsafe operator|invalid operator/)
  })
  it("rejects signed challenge for another origin", async () => {
    await offer({}, { serviceOrigin: "https://attacker.example" })
    await expect(beginKeeperPairing(discovery, boards, { futureBoards: false, futureBoardBaselineIds: ["board"] })).rejects.toThrow("not bound")
  })
  it.each([true, false])("sends explicit owner decision %s", async approve => {
    fetchMock.mockResolvedValue(reply({ ok: true }))
    await decideKeeperPairing(pairing, approve)
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { signed: { payload: Record<string, unknown> } }
    expect(body.signed.payload).toMatchObject({ decision: approve ? "approve" : "decline", challengeNonce: "nonce", transcriptHash: "transcript" })
  })
  it.each(["pending", "approved", "rejected", "expired"])("accepts signed %s status", async status => {
    fetchMock.mockResolvedValue(reply(await envelope("keeper-pairing-status", pairingPayload(status))))
    await expect(getKeeperPairingStatus(pairing)).resolves.toBe(status)
  })
  it("rejects status from another integration", async () => {
    fetchMock.mockResolvedValue(reply(await envelope("keeper-pairing-status", { ...pairingPayload(), integrationId: "foreign" })))
    await expect(getKeeperPairingStatus(pairing)).rejects.toThrow("another pairing")
  })
  it.each([
    ["active", undefined, "omitted durable"],
    ["active", [{ workspaceId: "other", status: "active" }], "approved board set"],
    ["active", [{ workspaceId: "board", status: "pending" }], "before every"],
    ["provisioning", [{ workspaceId: "board", status: "pending", error: "join_failed", errorDetail: "Rejected snapshot" }], "Rejected snapshot"],
    ["provisioning", [{ workspaceId: "board", status: "pending", error: "runtime_unavailable" }], "runtime is unavailable"],
  ] as const)("rejects unsafe provisioning %s %j", async (status, scopes, error) => {
    fetchMock.mockResolvedValue(reply(await envelope("keeper-pairing-status", { ...pairingPayload(status), provisioning: scopes ? { scopes } : undefined })))
    await expect(getKeeperPairingStatus(pairing)).rejects.toThrow(error)
  })
  it("Given a durable active scope, when a positive grant epoch is confirmed, then activation succeeds", async () => {
    fetchMock.mockResolvedValue(reply(await envelope("keeper-pairing-status", { ...pairingPayload("active"),
      provisioning: { scopes: [{ workspaceId: "board", status: "active", grantEpoch: 2 }] } })))
    await expect(getKeeperPairingStatus(pairing)).resolves.toBe("active")
  })
  it("Given join failure without details, when provisioning is queried, then retry explains missing service evidence", async () => {
    fetchMock.mockResolvedValue(reply(await envelope("keeper-pairing-status", { ...pairingPayload("provisioning"),
      provisioning: { scopes: [{ workspaceId: "board", status: "pending", error: "join_failed" }] } })))
    await expect(getKeeperPairingStatus(pairing)).rejects.toThrow("No error detail")
  })
  it("Given an HTTP failure without a service message, when requesting status, then the response code is preserved", async () => {
    fetchMock.mockResolvedValue(reply({}, 502))
    await expect(getKeeperPairingStatus(pairing)).rejects.toThrow("502")
  })
  it("retries identical signed provision after transport failure and accepts durable activation", async () => {
    const invitation = { invitationId: "invite" } as unknown as WorkspaceJoinInvitation
    fetchMock.mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(reply(await envelope("keeper-pairing-status", { ...pairingPayload("provisioning"), provisioning: { scopes: [{ workspaceId: "board", status: "pending" }] } })))
      .mockResolvedValueOnce(reply(await envelope("keeper-pairing-status", { ...pairingPayload("active"), provisioning: { scopes: [{ workspaceId: "board", status: "active" }] } })))
    await expect(deliverKeeperInvitation(pairing, invitation)).rejects.toThrow("offline")
    await expect(deliverKeeperInvitation(pairing, invitation)).resolves.toBe("provisioning")
    await expect(deliverKeeperInvitation(pairing, invitation)).resolves.toBe("active")
    expect(new Set(fetchMock.mock.calls.map(call => call[1]?.body)).size).toBe(1)
  })
  it("rejects provisioning response for another pairing", async () => {
    fetchMock.mockResolvedValue(reply(await envelope("keeper-pairing-status", { ...pairingPayload("active"), pairingId: "other" })))
    await expect(deliverKeeperInvitation(pairing, {} as WorkspaceJoinInvitation)).rejects.toThrow("another pairing")
  })
  it.each([reply({ message: "service error" }, 400), reply(null), new Response("not-json")])("surfaces failed or invalid HTTP responses", async response => {
    fetchMock.mockResolvedValue(response)
    await expect(getKeeperPairingStatus(pairing)).rejects.toThrow(/service error|invalid pairing response/)
  })
})

describe("keeper integration confirmation", () => {
  async function statusReply(overrides: Record<string, unknown> = {}) {
    fetchMock.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { signed: { payload: Record<string, unknown> } }
      return reply(await envelope("keeper-integration-status", { ...integrationPayload(request.signed.payload.operationId), ...overrides }))
    })
  }
  it("persists only verified exact board and future-board policy", async () => {
    await statusReply()
    const save = vi.spyOn(ownerKeeper, "saveKeeperIntegrationReference").mockResolvedValue(undefined)
    const remember = vi.spyOn(ownerKeeper, "rememberActivatedKeeper").mockResolvedValue(undefined)
    const descriptor = await rememberActiveKeeperIntegration(pairing)
    expect(descriptor).toMatchObject({ state: "active", workspaceIds: ["board"], revision: 2, futureBoards: false })
    expect(save).toHaveBeenCalledWith(descriptor)
    expect(remember).toHaveBeenCalledWith(owner.identity.personId, discovery.personId, expect.objectContaining({ integrationId: "integration" }))
  })
  it("rejects replayed controller response", async () => {
    await statusReply({ operationId: "old-operation" })
    await expect(getKeeperIntegrationStatus(discovery)).rejects.toThrow("does not match this controller")
  })
  it("rejects mismatched approved baseline before persisting", async () => {
    await statusReply()
    const save = vi.spyOn(ownerKeeper, "saveKeeperIntegrationReference")
    await expect(rememberActiveKeeperIntegration({ ...pairing, futureBoardBaselineIds: ["other"] })).rejects.toThrow("not confirmed")
    expect(save).not.toHaveBeenCalled()
  })
  it("keeps unavailable status confirmation pending", async () => {
    fetchMock.mockResolvedValue(reply({}, 503))
    await expect(getKeeperIntegrationStatus(discovery)).rejects.toThrow("confirmation remains pending")
  })
})

describe("keeper removal receipts", () => {
  const scopes = [{ workspaceId: "board", expectedGrantEpoch: 1 }]
  async function removalReply(overrides: Record<string, unknown> = {}) {
    fetchMock.mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { signed: { payload: Record<string, unknown> } }
      const semantic = { ...request.signed.payload }
      delete semantic.controllerDeviceId
      delete semantic.issuedAt
      delete semantic.expiresAt
      const requestHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(semantic)))
      return reply(await envelope("keeper-integration-disconnect-receipt", { version: 1, integrationId: "integration", operationId: "remove",
        controllerPersonId: owner.identity.personId, servicePersonId: discovery.personId, serviceDeviceId: discovery.deviceId,
        serviceOrigin: discovery.origin, requestHash, revision: 3, status: "removed",
        scopes: [{ workspaceId: "board", grantEpoch: 1, state: "removed", cleanup: "complete" }], ...overrides }))
    })
  }
  it.each(["removed", "pending"])("accepts exact signed %s receipt", async status => {
    await removalReply({ status, scopes: [{ workspaceId: "board", grantEpoch: 1, state: status, cleanup: status === "removed" ? "complete" : "pending" }] })
    await expect(disconnectKeeperIntegration(discovery, "integration", 2, "remove", scopes)).resolves.toMatchObject({ status, revision: 3 })
  })
  it.each([
    [{ requestHash: "foreign" }, "different keeper removal"],
    [{ scopes: [] }, "exact requested boards"],
    [{ scopes: [{ workspaceId: "board", grantEpoch: 2, state: "removed", cleanup: "complete" }] }, "another grant generation"],
    [{ scopes: [{ workspaceId: "board", grantEpoch: 1, state: "removed", cleanup: "pending" }] }, "before every selected"],
    [{ scopes: [null] }, "malformed scope"],
  ] as const)("rejects unsafe removal receipt %j", async (overrides, error) => {
    await removalReply(overrides)
    await expect(disconnectKeeperIntegration(discovery, "integration", 2, "remove", scopes)).rejects.toThrow(error)
  })
  it("rejects invalid removal and changed persisted operation before HTTP", async () => {
    await expect(disconnectKeeperIntegration(discovery, "integration", 2, "remove", [])).rejects.toThrow("request is invalid")
    await expect(disconnectKeeperIntegration(discovery, "integration", 2, "remove", scopes, "foreign-hash")).rejects.toThrow("persisted operation")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
