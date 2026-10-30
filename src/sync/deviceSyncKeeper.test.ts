import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot, registerWorkspaceInRoot } from "../domain/personalRoot"
import { defaultStorage } from "../storage"
import type { DurableMesh } from "./durableMesh"
import { createKeeperProvisioner, removeKeeperAccess, updateKeeperIntegrationAccess } from "./deviceSyncKeeper"
import { ownerKeepers, saveKeeperIntegrationReference, saveOwnerKeeper } from "./ownerKeeper"
import * as ownerKeeperStorage from "./ownerKeeper"
import * as keeperPairing from "./keeperPairing"
import * as integrationSettingsApi from "./keeperIntegrationSettingsApi"

describe("keeper removal", () => {
  beforeEach(() => resetIdentityStorageForTest())
  afterEach(() => vi.restoreAllMocks())

  async function setupOwnerKeeper(scopeIds: string[]) {
    const profile = await bootstrapIdentity("Keeper owner")
    const owner = profile.identity.personId
    const keeper = `keeper-${crypto.randomUUID()}`
    const root = createPersonalRoot(profile, "keeper-test-certificate")
    for (const id of scopeIds) registerWorkspaceInRoot(root, id, id, "import")
    root.keeperIntegrations = {
      integration: {
        integrationId: "integration",
        serviceOrigin: "https://rusty.example",
        servicePersonId: keeper,
        serviceDeviceId: "rusty-device",
        servicePublicKey: "rusty-public-key",
        serviceCertificates: [],
        workspaceIds: scopeIds,
        scopeReceipts: scopeIds.map(workspaceId => ({ workspaceId, grantEpoch: 1, activationOperationId: "activation" })),
        futureBoards: false,
        integrationSettingsSupported: true,
        futureBoardBaselineIds: scopeIds,
        revision: 1,
        state: "active",
        verifiedAt: new Date().toISOString(),
      },
    }
    await defaultStorage.savePersonalRoot(root)
    return {
      profile,
      owner,
      keeper,
      discovery: {
        origin: "https://rusty.example",
        displayName: "Rusty keeper",
        personId: keeper,
        deviceId: "rusty-device",
        publicKey: "rusty-public-key",
        certificates: [],
        fingerprint: "",
        capabilities: { modes: ["replicate" as const], documentReplication: true, chatReplication: true, blobReplication: true, pairing: true },
      },
    }
  }

  it("does not issue an approved policy-only update when target cleanup starts before provision", async () => {
    const { discovery } = await setupOwnerKeeper(["board"])
    const pendingError = new Error("Rusty has board cleanup pending for this integration or selected board.")
    const refresh = vi.spyOn(keeperPairing, "refreshKeeperGrantFloors").mockRejectedValue(pendingError)
    const ensureDurableMesh = vi.fn(async () => {})
    const hostContext = vi.fn(() => ({} as never))
    const pairing = {
      pairingId: "approved-pairing",
      integrationId: "integration",
      operatorUrl: "https://rusty.example/approve",
      comparisonCode: "ABC-123",
      expiresAt: Date.now() + 60_000,
      transcriptHash: "transcript",
      challengeNonce: "nonce",
      controllerFingerprint: "controller",
      discovery,
      workspaces: [],
      futureBoards: true,
      integrationUpdate: { integrationId: "integration", expectedRevision: 3,
        scopeWorkspaceIds: [], policy: { futureBoards: true, baselineWorkspaceIds: ["board"] }, policyOnly: true },
    } as never

    await expect(createKeeperProvisioner(ensureDurableMesh, hostContext)(pairing)).rejects.toBe(pendingError)

    expect(refresh).toHaveBeenCalledWith(discovery, [], undefined, "integration")
    expect(ensureDurableMesh).not.toHaveBeenCalled()
    expect(hostContext).not.toHaveBeenCalled()
  })

  it("revokes every owned board locally and keeps policy while Rusty confirmation is unavailable", async () => {
    const { profile, owner, keeper, discovery } = await setupOwnerKeeper(["other", "active"])
    const revokePerson = vi.fn(async () => {})
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ message: "offline Rusty" }), { status: 503, headers: { "Content-Type": "application/json" } },
    ))
    await saveOwnerKeeper(owner, { personId: keeper, role: "visitor" })
    const options: Parameters<typeof removeKeeperAccess>[1] = {
      getProfile: async () => profile,
      workspaces: [{ id: "active" }, { id: "other" }, { id: "guest" }],
      workspaceOwner: async id => id === "guest" ? "someone-else" : owner,
      mesh: async () => ({ revokePerson }) as unknown as DurableMesh,
      activeWorkspaceId: "active",
      discovery,
      knownServiceDeviceIds: ["rusty-device"],
    }
    await expect(removeKeeperAccess(keeper, options))
      .rejects.toThrow("Local access was revoked; Rusty confirmation is still pending")
    await expect(removeKeeperAccess(keeper, options))
      .rejects.toThrow("Local access was revoked; Rusty confirmation is still pending")
    expect(revokePerson.mock.calls).toEqual([
      ["other", keeper, 1], ["active", keeper, 1],
      ["other", keeper, 1], ["active", keeper, 1],
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: keeper, role: "visitor" }])
  })

  it("rejects a stale saved grant epoch before changing access or contacting Rusty", async () => {
    const { profile, owner, keeper, discovery } = await setupOwnerKeeper(["board"])
    const revokePerson = vi.fn(async (_workspaceId: string, _personId: string, expectedGrantEpoch?: number) => {
      if (expectedGrantEpoch !== 2) throw new Error("A newer keeper grant exists; this removal cannot revoke it.")
    })
    const fetchMock = vi.spyOn(globalThis, "fetch")
    const before = (await ownerKeeperStorage.keeperIntegrationReferences()).integrations.integration

    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile,
      workspaces: [{ id: "board" }], workspaceOwner: async () => owner,
      mesh: async () => ({ revokePerson }) as unknown as DurableMesh,
      discovery,
    })).rejects.toThrow("A newer keeper grant exists; this removal cannot revoke it.")

    expect(revokePerson.mock.calls).toEqual([["board", keeper, 1]])
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(ownerKeeperStorage.keeperIntegrationReferences()).resolves.toMatchObject({
      integrations: { integration: before },
    })
  })

  it("does not let a late removal receipt replace a newer active integration or delete its keeper row", async () => {
    const { profile, owner, keeper, discovery } = await setupOwnerKeeper(["board"])
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor" })
    const active = { integrationId: "integration", revision: 1, futureBoards: false, scopes: [
      { workspaceId: "board", grantEpoch: 1, state: "active" as const, activationOperationId: "activation" },
    ], tombstones: [] }
    vi.spyOn(keeperPairing, "getKeeperIntegrationStatus").mockResolvedValue({
      integrations: [active], integrationSettingsSupported: true, signerKeyId: "rusty-device", signature: "signed", revision: 1,
      signedStatus: { payload: {}, signerKeyId: "rusty-device", signature: "signed" },
    })
    vi.spyOn(keeperPairing, "disconnectKeeperIntegration").mockImplementation(async () => {
      const references = await ownerKeeperStorage.keeperIntegrationReferences()
      const prior = references.integrations.integration!
      await saveKeeperIntegrationReference({ ...prior, revision: 3, workspaceIds: ["new-board"],
        scopeReceipts: [{ workspaceId: "new-board", grantEpoch: 4, activationOperationId: "new-activation" }],
        state: "active", pendingRemoval: undefined })
      return { integrationId: "integration", operationId: "old-removal", requestHash: "old-hash", revision: 2,
        status: "removed", scopes: [{ workspaceId: "board", grantEpoch: 1, state: "removed", cleanup: "complete" }] }
    })

    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile,
      workspaces: [{ id: "board" }], workspaceOwner: async () => owner,
      mesh: async () => ({ revokePerson: vi.fn(async () => {}) }) as unknown as DurableMesh,
      discovery,
    })).rejects.toThrow("Rusty confirmed removal; local keeper cleanup is pending")

    await expect(ownerKeeperStorage.keeperIntegrationReferences()).resolves.toMatchObject({ integrations: {
      integration: { revision: 3, state: "active", workspaceIds: ["new-board"], scopeReceipts: [
        { workspaceId: "new-board", grantEpoch: 4 },
      ] },
    } })
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: keeper, role: "editor" }])
  })

  it("preserves same-revision removal intent against a late active status write", async () => {
    await setupOwnerKeeper(["board"])
    const { integrations } = await ownerKeeperStorage.keeperIntegrationReferences()
    const reference = integrations.integration!
    const pending = { ...reference, state: "removing" as const,
      pendingRemoval: { operationId: "pending-remove", expectedRevision: reference.revision,
        scopes: [{ workspaceId: "board", expectedGrantEpoch: 1 }] } }
    await saveKeeperIntegrationReference(pending)

    await expect(saveKeeperIntegrationReference(reference)).rejects.toThrow("Keeper removal intent changed")
    await expect(ownerKeeperStorage.keeperIntegrationReferences()).resolves.toMatchObject({ integrations: {
      integration: { state: "removing", pendingRemoval: { operationId: "pending-remove" } },
    } })
  })

  it("does not let terminal cleanup delete a keeper cache row activated after its root receipt", async () => {
    const { profile, owner, keeper, discovery } = await setupOwnerKeeper(["board"])
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor", details: {
      integrationId: "integration", revision: 1, origin: discovery.origin, boardIds: ["board"], futureBoards: false,
    } })
    const active = { integrationId: "integration", revision: 1, futureBoards: false, scopes: [
      { workspaceId: "board", grantEpoch: 1, state: "active" as const, activationOperationId: "activation" },
    ], tombstones: [] }
    vi.spyOn(keeperPairing, "getKeeperIntegrationStatus").mockResolvedValue({
      integrations: [active], integrationSettingsSupported: true, signerKeyId: "rusty-device", signature: "signed", revision: 1,
      signedStatus: { payload: {}, signerKeyId: "rusty-device", signature: "signed" },
    })
    vi.spyOn(keeperPairing, "disconnectKeeperIntegration").mockResolvedValue({
      integrationId: "integration", operationId: "old-removal", requestHash: "old-hash", revision: 2,
      status: "removed", scopes: [{ workspaceId: "board", grantEpoch: 1, state: "removed", cleanup: "complete" }],
    })
    const removeCache = ownerKeeperStorage.removeOwnerKeeper
    vi.spyOn(ownerKeeperStorage, "removeOwnerKeeper").mockImplementation(async (ownerPersonId, personId, expected) => {
      const { integrations } = await ownerKeeperStorage.keeperIntegrationReferences()
      const prior = integrations.integration!
      await saveKeeperIntegrationReference({ ...prior, revision: 3, workspaceIds: ["new-board"],
        scopeReceipts: [{ workspaceId: "new-board", grantEpoch: 4, activationOperationId: "new-activation" }],
        state: "active", pendingRemoval: undefined })
      await saveOwnerKeeper(ownerPersonId, { personId, role: "editor", details: {
        integrationId: "integration", revision: 3, origin: discovery.origin, boardIds: ["new-board"], futureBoards: true,
      } })
      return removeCache(ownerPersonId, personId, expected)
    })

    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile,
      workspaces: [{ id: "board" }], workspaceOwner: async () => owner,
      mesh: async () => ({ revokePerson: vi.fn(async () => {}) }) as unknown as DurableMesh,
      discovery,
    })).resolves.toBe("removed")

    await expect(ownerKeeperStorage.keeperIntegrationReferences()).resolves.toMatchObject({ integrations: {
      integration: { revision: 3, state: "active", workspaceIds: ["new-board"] },
    } })
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: keeper, role: "editor", details: {
      integrationId: "integration", revision: 3, origin: discovery.origin, boardIds: ["new-board"], futureBoards: true,
    } }])
  })

  it("does not let a delayed partial-removal receipt replace a different canonical integration cache", async () => {
    const { owner, keeper } = await setupOwnerKeeper(["old-board"])
    const root = await defaultStorage.loadPersonalRoot()
    const old = root!.keeperIntegrations!.integration!
    root!.keeperIntegrations = {
      integration: { ...old, state: "removed", workspaceIds: [], revision: 2 },
      "new-integration": { ...old, integrationId: "new-integration", state: "active", workspaceIds: ["new-board"], revision: 1 },
    }
    await defaultStorage.savePersonalRoot(root!)
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor", details: {
      integrationId: "new-integration", revision: 1, boardIds: ["new-board"], futureBoards: true,
    } })

    await expect(saveOwnerKeeper(owner, { personId: keeper, role: "editor", details: {
      integrationId: "integration", revision: 2, boardIds: ["old-board"], futureBoards: false,
    } })).rejects.toThrow("not the current canonical integration")
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: keeper, role: "editor", details: {
      integrationId: "new-integration", revision: 1, boardIds: ["new-board"], futureBoards: true,
    } }])

    await ownerKeeperStorage.removeOwnerKeeper(owner, keeper)
    await expect(saveOwnerKeeper(owner, { personId: keeper, role: "editor", details: {
      integrationId: "integration", revision: 2, boardIds: ["old-board"], futureBoards: false,
    } })).rejects.toThrow("not the current canonical integration")
    await expect(ownerKeepers(owner)).resolves.toEqual([])
  })

  it("does not revoke a legacy descriptor locally when no saved grant generation exists", async () => {
    const { profile, owner, keeper, discovery } = await setupOwnerKeeper(["board"])
    const root = await defaultStorage.loadPersonalRoot()
    root!.keeperIntegrations!.integration!.scopeReceipts = []
    await defaultStorage.savePersonalRoot(root!)
    const revokePerson = vi.fn(async () => {})
    vi.spyOn(keeperPairing, "getKeeperIntegrationStatus").mockRejectedValue(new Error("Rusty offline"))

    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile, workspaces: [{ id: "board" }], workspaceOwner: async () => owner,
      mesh: async () => ({ revokePerson }) as unknown as DurableMesh, discovery,
    })).rejects.toThrow("Rusty offline")
    expect(revokePerson).not.toHaveBeenCalled()
  })

  it("keeps owner policy when any board cannot be revoked", async () => {
    const { profile, owner, keeper, discovery } = await setupOwnerKeeper(["board"])
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor" })
    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile,
      workspaces: [{ id: "board" }], workspaceOwner: async () => owner,
      mesh: async () => ({ revokePerson: async () => { throw new Error("offline board") } }) as unknown as DurableMesh,
      discovery,
    })).rejects.toThrow("offline board")
    await expect(ownerKeepers(owner)).resolves.toEqual([{ personId: keeper, role: "editor" }])
  })

  it("revokes only locally owned legacy boards and finishes removal without a Rusty address", async () => {
    const { profile, owner, keeper } = await setupOwnerKeeper(["owned", "foreign"])
    const root = await defaultStorage.loadPersonalRoot()
    root!.keeperIntegrations = {}
    await defaultStorage.savePersonalRoot(root!)
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor", details: {
      boardIds: ["owned", "foreign"], futureBoards: false,
    } })
    let intentPersistedBeforeRevoke = false
    const revokePerson = vi.fn(async () => {
      intentPersistedBeforeRevoke = (await ownerKeepers(owner))[0]?.details?.removalPending === true
    })
    const trace = vi.fn()
    const fetchMock = vi.spyOn(globalThis, "fetch")

    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile,
      workspaces: [{ id: "owned" }, { id: "foreign" }],
      workspaceOwner: async id => id === "owned" ? owner : "another-owner",
      mesh: async () => ({ revokePerson }) as unknown as DurableMesh,
      knownServiceDeviceIds: ["rusty-device"],
      trace,
    })).resolves.toBe("removed")

    expect(revokePerson.mock.calls).toEqual([["owned", keeper]])
    expect(trace).toHaveBeenCalledWith("scope-owner", { peerId: keeper, workspaceId: "owned", outcome: "owner" })
    expect(trace).toHaveBeenCalledWith("scope-owner", { peerId: keeper, workspaceId: "foreign", outcome: "other" })
    expect(trace).toHaveBeenCalledWith("revoke-complete", { peerId: keeper, workspaceId: "owned", outcome: "success" })
    expect(intentPersistedBeforeRevoke).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(ownerKeepers(owner)).resolves.toEqual([])
  })
  it("recovers missing legacy board lists from available owned boards and disables future access", async () => {
    const { profile, owner, keeper } = await setupOwnerKeeper(["owned", "foreign"])
    const root = await defaultStorage.loadPersonalRoot()
    root!.keeperIntegrations = {}
    await defaultStorage.savePersonalRoot(root!)
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor" })
    const revokePerson = vi.fn(async () => {})
    const fetchMock = vi.spyOn(globalThis, "fetch")
    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile,
      workspaces: [{ id: "owned" }, { id: "foreign" }],
      workspaceOwner: async id => id === "owned" ? owner : "another-owner",
      mesh: async () => ({ revokePerson }) as unknown as DurableMesh,
      knownServiceDeviceIds: ["rusty-device"],
    })).resolves.toBe("removed")
    expect(revokePerson.mock.calls).toEqual([["owned", keeper]])
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(ownerKeepers(owner)).resolves.toEqual([])
  })

  it("retries local keeper cleanup after a verified removal receipt survives restart", async () => {
    const { profile, owner, keeper } = await setupOwnerKeeper(["board"])
    await saveOwnerKeeper(owner, { personId: keeper, role: "editor" })
    const revokePerson = vi.fn(async () => {})
    const mesh = { revokePerson, views: vi.fn(async () => []) } as unknown as DurableMesh
    const active = { integrationId: "integration", revision: 1, futureBoards: false, scopes: [
      { workspaceId: "board", grantEpoch: 1, state: "active" as const, activationOperationId: "activation" },
    ], tombstones: [] }
    const removed = { ...active, revision: 2, scopes: [], tombstones: [
      { workspaceId: "board", grantEpoch: 1, operationId: "remove-op", state: "removed" as const, cleanup: "complete" as const },
    ] }
    const status = vi.spyOn(keeperPairing, "getKeeperIntegrationStatus")
      .mockResolvedValueOnce({ integrations: [active], integrationSettingsSupported: false, signerKeyId: "rusty-device", signature: "signed", revision: 1,
        signedStatus: { payload: {}, signerKeyId: "rusty-device", signature: "signed" } })
      .mockResolvedValue({ integrations: [removed], integrationSettingsSupported: false, signerKeyId: "rusty-device", signature: "signed", revision: 2,
        signedStatus: { payload: {}, signerKeyId: "rusty-device", signature: "signed" } })
    vi.spyOn(keeperPairing, "disconnectKeeperIntegration").mockResolvedValue({
      integrationId: "integration", operationId: "remove-op", requestHash: "request-hash", revision: 2,
      status: "removed", scopes: [{ workspaceId: "board", grantEpoch: 1, state: "removed", cleanup: "complete" }],
    })
    vi.spyOn(ownerKeeperStorage, "removeOwnerKeeper").mockRejectedValueOnce(new Error("storage unavailable"))
    const options = {
      getProfile: async () => profile,
      workspaces: [{ id: "board" }], workspaceOwner: async () => owner, mesh: async () => mesh,
    }

    await expect(removeKeeperAccess(keeper, options)).rejects.toThrow("Rusty confirmed removal; local keeper cleanup is pending")
    const afterReceipt = (await ownerKeeperStorage.keeperIntegrationReferences()).integrations.integration
    expect(afterReceipt).toMatchObject({ state: "removed", workspaceIds: [], completedRemoval: {
      operationId: "remove-op", scopes: [{ workspaceId: "board", grantEpoch: 1 }],
    } })

    await expect(removeKeeperAccess(keeper, options)).resolves.toBe("removed")
    expect(status).toHaveBeenCalledTimes(2)
    expect(revokePerson.mock.calls).toEqual([["board", keeper, 1], ["board", keeper, 1]])
    await expect(ownerKeepers(owner)).resolves.toEqual([])
    expect((await ownerKeeperStorage.keeperIntegrationReferences()).integrations.integration?.scopeReceipts).toEqual([])
  })

  it("uses completed generation when active receipt list is empty during cleanup retry", async () => {
    const { profile, owner, keeper, discovery } = await setupOwnerKeeper(["board"])
    const root = await defaultStorage.loadPersonalRoot()
    root!.keeperIntegrations!.integration = {
      ...root!.keeperIntegrations!.integration!, workspaceIds: [], scopeReceipts: [], state: "removed",
      completedRemoval: { operationId: "remove-op", scopes: [{ workspaceId: "board", grantEpoch: 1 }] },
    }
    await defaultStorage.savePersonalRoot(root!)
    const revokePerson = vi.fn(async () => {})
    const mesh = { revokePerson, views: async () => [{ workspaceId: "board", personId: keeper }] } as unknown as DurableMesh
    vi.spyOn(keeperPairing, "getKeeperIntegrationStatus").mockResolvedValue({
      integrations: [{ integrationId: "integration", revision: 2, futureBoards: false, scopes: [], tombstones: [
        { workspaceId: "board", grantEpoch: 1, operationId: "remove-op", state: "removed", cleanup: "complete" },
      ] }], integrationSettingsSupported: false, signerKeyId: "rusty-device", signature: "signed", revision: 2,
      signedStatus: { payload: {}, signerKeyId: "rusty-device", signature: "signed" },
    } as never)

    await expect(removeKeeperAccess(keeper, {
      getProfile: async () => profile, workspaces: [{ id: "board" }], workspaceOwner: async () => owner,
      mesh: async () => mesh, discovery,
    })).resolves.toBe("removed")
    expect(revokePerson.mock.calls).toEqual([["board", keeper, 1]])
  })

  it("retries every locally saved settings revocation with same signed request hash after a partial failure", async () => {
    const { profile, owner, keeper, discovery } = await setupOwnerKeeper(["board-a", "board-b"])
    const active = {
      integrationId: "integration", revision: 1, futureBoards: true, baselineWorkspaceIds: ["board-a", "board-b"],
      scopes: ["board-a", "board-b"].map(workspaceId => ({ workspaceId, grantEpoch: 9, state: "active" as const,
        activationOperationId: `activation-${workspaceId}` })), tombstones: [],
    }
    const removed = { ...active, revision: 2, futureBoards: false, scopes: [], tombstones: [
      { workspaceId: "board-a", grantEpoch: 9, operationId: "settings-op", state: "removed" as const, cleanup: "complete" as const },
      { workspaceId: "board-b", grantEpoch: 9, operationId: "settings-op", state: "removed" as const, cleanup: "complete" as const },
    ] }
    const signedStatus = (integration: typeof active | typeof removed) => ({ integrations: [integration],
      integrationSettingsSupported: true, signerKeyId: "rusty-device", signature: "signed", revision: integration.revision })
    const status = vi.spyOn(keeperPairing, "getKeeperIntegrationStatus")
      .mockResolvedValueOnce(signedStatus(active) as never)
      .mockResolvedValueOnce(signedStatus(active) as never)
      .mockResolvedValueOnce(signedStatus(removed) as never)
    const hash = vi.spyOn(integrationSettingsApi, "keeperIntegrationSettingsRequestHash").mockResolvedValue("stable-request-hash")
    const update = vi.spyOn(integrationSettingsApi, "updateKeeperIntegrationSettings").mockResolvedValue({
      integrationId: "integration", operationId: "settings-op", requestHash: "stable-request-hash", revision: 2,
      status: "updated", futureBoards: false, baselineWorkspaceIds: [], scopes: [
        { workspaceId: "board-a", grantEpoch: 9, state: "removed", cleanup: "complete" },
        { workspaceId: "board-b", grantEpoch: 9, state: "removed", cleanup: "complete" },
      ],
    })
    const revokePerson = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("board-b is temporarily unavailable"))
      .mockResolvedValue(undefined)
    const options = {
      getProfile: async () => profile,
      workspaces: [{ id: "board-a" }, { id: "board-b" }],
      workspaceOwner: async () => owner,
      mesh: async () => ({ revokePerson }) as unknown as DurableMesh,
      discovery,
    }

    await expect(updateKeeperIntegrationAccess(keeper, false, ["board-a", "board-b"], options))
      .rejects.toThrow("board-b is temporarily unavailable")
    const pending = (await ownerKeeperStorage.keeperIntegrationReferences()).integrations.integration?.pendingSettings
    expect(pending).toMatchObject({ requestHash: "stable-request-hash", futureBoards: false, scopes: [
      { workspaceId: "board-a", expectedGrantEpoch: 9 }, { workspaceId: "board-b", expectedGrantEpoch: 9 },
    ] })
    expect(update).not.toHaveBeenCalled()

    await expect(updateKeeperIntegrationAccess(keeper, false, ["board-a", "board-b"], options)).resolves.toBe("updated")
    expect(revokePerson.mock.calls).toEqual([
      ["board-a", keeper, 9], ["board-b", keeper, 9],
      ["board-a", keeper, 9], ["board-b", keeper, 9],
    ])
    expect(hash).toHaveBeenCalledOnce()
    expect(update.mock.calls[0]?.[3]).toBe(pending?.operationId)
    expect(update.mock.calls[0]?.[6]).toBe("stable-request-hash")
    expect(status).toHaveBeenCalledTimes(3)
    const saved = (await ownerKeeperStorage.keeperIntegrationReferences()).integrations.integration
    expect(saved).toMatchObject({ state: "active", workspaceIds: [], futureBoards: false, revision: 2 })
    expect(saved?.pendingSettings).toBeUndefined()
  })

})
