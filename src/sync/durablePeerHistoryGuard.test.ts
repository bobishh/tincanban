import { beforeEach, expect, it, vi } from "vitest"
import type { LocalProfile } from "../domain/identity"
import type { PeerStore, WorkspaceAuthorityRecord, WorkspaceMeshCredential, WorkspacePeerRecord } from "./peerStore"
import type { WorkspaceMemberBundle } from "./meshRecords"

const mocks = vi.hoisted(() => ({ verify: vi.fn(), hasAuthorityConflict: vi.fn(), isDeviceRevoked: vi.fn(),
  isGrantRevoked: vi.fn(), hasLeftWorkspace: vi.fn() }))
vi.mock("./meshRecords", () => ({ verifyWorkspaceMemberBundle: mocks.verify }))
vi.mock("@meta-uber/mesh-replication/runtime", () => ({ meshRustRuntime: () => ({ state: mocks }) }))
vi.mock("./durableMeshBase", () => ({ ownerAuthorities: () => [] }))
import { createDurablePeerHistoryGuard } from "./durablePeerHistoryGuard"

function fixture() {
  const profile = { identity: { personId: "local-person" }, device: { deviceId: "local-device" } } as LocalProfile
  const bundle = { advertisement: { signerKeyId: "remote-device", signature: "route-signature", payload: {
    kind: "peer-advertisement", version: 1, workspaceId: "board", personId: "remote-person", deviceId: "remote-device",
    endpoint: "old-route", issuedAt: "2026-10-21T18:00:00Z", instanceId: "tab-a" } },
  publicKey: "remote-public-key", certificates: [], grant: { signerKeyId: "owner-device", signature: "grant", payload: {
    kind: "workspace-grant", version: 1, grantId: "grant", workspaceId: "board", personId: "remote-person", role: "editor", accessEpoch: 1 } } } as WorkspaceMemberBundle
  const credential: WorkspaceMeshCredential = { version: 1, workspaceId: "board", ownerPersonId: "owner", ownerPublicKey: "owner-key",
    transportSecret: "secret", epoch: 1, updatedAt: "2026-10-21T18:00:00Z", ownerCertificates: [] }
  const authority: WorkspaceAuthorityRecord = { ...credential, ownerHistory: [] }
  const peer: WorkspacePeerRecord = { workspaceId: "board", deviceId: "remote-device", personId: "remote-person", role: "editor",
    endpoint: "old-route", instanceId: "tab-a", transportSecret: "secret", lastSeen: "2026-10-21T18:00:00Z", advertisement: bundle }
  const current = { credential, authority, peer, sessionCurrent: true }
  const store = { getWorkspaceCredential: async () => structuredClone(current.credential),
    getWorkspaceAuthority: async () => structuredClone(current.authority), getPeer: async () => structuredClone(current.peer) } as unknown as PeerStore
  mocks.verify.mockImplementation(async (selected: WorkspaceMemberBundle) => selected)
  const guard = createDurablePeerHistoryGuard({ workspaceId: "board", deviceId: peer.deviceId, remotePersonId: peer.personId,
    transportSecret: "secret", profile, store, profileProvider: async () => profile,
    assertSession: () => { if (!current.sessionCurrent) throw new Error("Direct peer session is no longer current") } })
  return { guard, current, bundle }
}

beforeEach(() => {
  vi.resetAllMocks()
  for (const check of [mocks.hasAuthorityConflict, mocks.isDeviceRevoked, mocks.isGrantRevoked, mocks.hasLeftWorkspace]) check.mockReturnValue(false)
})

it("Given unchanged signed access, when history is guarded, then verify the peer and current policies", async () => {
  const f = fixture()
  await expect(f.guard()).resolves.toBeUndefined()
  expect(mocks.verify).toHaveBeenCalledOnce()
  expect(mocks.isDeviceRevoked).toHaveBeenCalledWith(f.current.authority, "remote-person", "remote-device")
})

it.each(["credential", "authority", "peer"] as const)(
  "Given unchanged access, when a merge adds undefined optional fields to the %s, then retain the authenticated history channel", async target => {
    const f = fixture()
    mocks.verify.mockImplementationOnce(async selected => {
      if (target === "peer") f.current.peer.revokedAt = undefined
      else f.current[target].scopeAuthoritySnapshot = undefined
      return selected
    })
    await expect(f.guard()).resolves.toBeUndefined()
  })

it("Given unchanged grants and revocations, when synchronization fills empty authority collections, then keep the current history session", async () => {
  const f = fixture()
  delete f.current.authority.ownerHistory
  mocks.verify.mockImplementationOnce(async selected => {
    const catalog = { departures: [], deviceRevocations: [], revocations: [], ownershipTransfers: [], successionVotes: [], successionClaims: [] }
    f.current.credential.catalog = catalog
    f.current.authority.catalog = catalog
    f.current.credential.ownerHistory = []
    f.current.authority.ownerHistory = []
    return selected
  })
  await expect(f.guard()).resolves.toBeUndefined()
})

it("Given unchanged signed access, when presence advances during bundle verification, then history remains authorized", async () => {
  const f = fixture()
  mocks.verify.mockImplementationOnce(async selected => {
    f.current.peer.lastSeen = "2026-10-21T18:00:01Z"
    return selected
  })
  await expect(f.guard()).resolves.toBeUndefined()
})

it("Given unchanged signed access, when record timestamps advance during bundle verification, then history remains authorized", async () => {
  const f = fixture()
  mocks.verify.mockImplementationOnce(async selected => {
    f.current.credential.updatedAt = f.current.authority.updatedAt = "2026-10-21T18:00:01Z"
    return selected
  })
  await expect(f.guard()).resolves.toBeUndefined()
})

it("Given the same authenticated device and grant, when a new signed route arrives during verification, then retain the active history channel", async () => {
  const f = fixture()
  mocks.verify.mockImplementationOnce(async selected => {
    const route = structuredClone(f.bundle)
    route.advertisement.payload.endpoint = "new-route"
    route.advertisement.payload.issuedAt = "2026-10-21T18:00:01Z"
    route.advertisement.signature = "new-route-signature"
    f.current.peer = { ...f.current.peer, endpoint: "new-route", lastSeen: "2026-10-21T18:00:01Z", advertisement: route }
    return selected
  })
  await expect(f.guard()).resolves.toBeUndefined()
  expect(mocks.verify).toHaveBeenCalledTimes(2)
  expect(mocks.verify.mock.calls[1]?.[0]).toEqual(f.current.peer.advertisement)
})

it("Given a refreshed route with invalid signed proof, when verification is pending, then reject without accepting its route metadata", async () => {
  const f = fixture()
  mocks.verify.mockImplementationOnce(async selected => {
    f.current.peer.advertisement = { ...f.bundle, advertisement: { ...f.bundle.advertisement, signature: "invalid" } }
    return selected
  }).mockRejectedValueOnce(new Error("Invalid advertisement signature"))
  await expect(f.guard()).rejects.toThrow("Invalid advertisement signature")
  expect(mocks.verify).toHaveBeenCalledTimes(2)
})

it.each(["revocation", "session"] as const)("Given a refreshed route under verification, when %s changes, then refuse before serving history", async change => {
  const f = fixture()
  mocks.verify.mockImplementationOnce(async selected => {
    f.current.peer.advertisement = { ...f.bundle, advertisement: { ...f.bundle.advertisement, signature: "new-valid-route" } }
    return selected
  }).mockImplementationOnce(async selected => {
    if (change === "revocation") f.current.authority.catalog = { deviceRevocations: [{ deviceId: "remote-device" }] }
    else f.current.sessionCurrent = false
    return selected
  })
  await expect(f.guard()).rejects.toThrow(/authorization changed|session is no longer current/i)
})

it("Given a sibling tab only refreshes its route list, when a history guard is checking, then preserve the current authenticated channel", async () => {
  const f = fixture()
  mocks.verify.mockImplementationOnce(async selected => {
    f.current.peer.instances = [{ instanceId: "tab-b", endpoint: "sibling-route", lastSeen: "2026-10-21T18:00:01Z" }]
    return selected
  })
  await expect(f.guard()).resolves.toBeUndefined()
  expect(mocks.verify).toHaveBeenCalledOnce()
})

it.each(["revocation", "role", "grant", "owner", "transport", "device key", "certificate"] as const)(
  "Given a real %s change during verification, when history is guarded, then deny the stale read", async change => {
    const f = fixture()
    mocks.verify.mockImplementationOnce(async selected => {
      if (change === "revocation") f.current.peer.revokedAt = "2026-10-21T18:00:01Z"
      if (change === "role") f.current.peer.role = "visitor"
      if (change === "grant") (f.current.peer.advertisement as WorkspaceMemberBundle).grant!.signature = "replacement"
      if (change === "owner") f.current.authority.ownerPersonId = "other-owner"
      if (change === "transport") f.current.credential.transportSecret = "rotated"
      if (change === "device key") (f.current.peer.advertisement as WorkspaceMemberBundle).publicKey = "replacement-key"
      if (change === "certificate") (f.current.peer.advertisement as WorkspaceMemberBundle).certificates.push({ signature: "replacement" } as WorkspaceMemberBundle["certificates"][number])
      return selected
    })
    await expect(f.guard()).rejects.toThrow(/authorization changed|access changed|revoked/i)
  })
