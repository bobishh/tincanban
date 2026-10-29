import { afterEach, beforeEach, expect, it, vi } from "vitest"
import * as identitySdk from "@meta-uber/mesh-identity"
import type { LocalProfile } from "../domain/identity"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { certHashDefault } from "../domain/proofs"
import { identityAuthorityViewKey } from "../domain/identityAuthority"
import * as local from "../localDb"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"
import type { WorkspaceMeshCredential } from "./peerStore"

const mocks = vi.hoisted(() => ({ isDeviceRevoked: vi.fn() }))
vi.mock("@meta-uber/mesh-replication/runtime", () => ({ meshRustRuntime: () => ({ state: {
  isDeviceRevoked: mocks.isDeviceRevoked, hasAuthorityConflict: () => false,
  isGrantRevoked: () => false, hasLeftWorkspace: () => false,
} }) }))

import { createEnrollmentHistoryAuthorizationGuard } from "./enrollmentHistoryAuthorization"

const profile = (personId = "person-a", deviceId = "device-a") => ({
  identity: { personId, publicKey: "public-key", displayName: "Owner" },
  device: { deviceId, publicKey: "device-key", displayName: "Owner device" },
  privateKeys: { devicePrivateKey: {} }, certificate: {},
} as unknown as LocalProfile)

const credential = (workspaceId: string) => ({ version: 1, workspaceId } as unknown as WorkspaceMeshCredential)

const snapshotReader = (read: (id: string) => Promise<WorkspaceMeshCredential | undefined>) =>
  async (ids: readonly string[]) => Promise.all(ids.map(async workspaceId => ({ workspaceId,
    credential: (await read(workspaceId)) ?? null, authority: null })))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isDeviceRevoked.mockReturnValue(false)
})

afterEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })

async function signedEnrollmentFixture() {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Enrollment owner")
  const phone = await identitySdk.createIdentityEnrollmentDevice("Approved phone")
  const phoneCertificate = await identitySdk.createDelegatedCertificate(owner.privateKeys.devicePrivateKey,
    owner.device.deviceId, owner.identity.personId, phone.device.deviceId, phone.device.publicKey, await certHashDefault(owner.certificate))
  const certificates = [owner.certificate, phoneCertificate], state = identitySdk.emptyIdentityProfileState(owner.identity.personId)
  const before = await identitySdk.createIdentityAuthorityView(owner.identity, { certificates, revocations: [] }, state)
  await mergeIdentityAuthorityView(before)
  const other = await identitySdk.createIdentityEnrollmentDevice("Other authorized device")
  const added = await identitySdk.createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, other.device.deviceId, other.device.publicKey, await certHashDefault(owner.certificate))
  const expanded = await identitySdk.createIdentityAuthorityView(owner.identity, { certificates: [...certificates, added], revocations: [] }, state)
  const revoked = await identitySdk.createDeviceRevocation(owner,
    await identitySdk.verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] }), phone.device.deviceId, state)
  const revokedView = await identitySdk.createIdentityAuthorityView(owner.identity, { certificates, revocations: [revoked] }, state)
  return { owner, phone, expanded, revokedView }
}

it.each(["additional certificate", "revocation", "missing authority"] as const)(
  "Given signed enrollment authority changes during workspace verification (%s), when checking current access, then recheck additions and deny lost access",
  async change => {
    const f = await signedEnrollmentFixture()
    let reads = 0
    const guard = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board"], profile: f.owner,
      remoteDeviceId: f.phone.device.deviceId, isCurrent: () => true, readProfile: async () => f.owner,
      readWorkspaces: async ids => {
        if (++reads === 1) {
          if (change === "missing authority") await local.deleteLocal(identityAuthorityViewKey(f.owner.identity.personId))
          else await mergeIdentityAuthorityView(change === "revocation" ? f.revokedView : f.expanded)
        }
        return ids.map(workspaceId => ({ workspaceId, credential: credential(workspaceId), authority: null }))
      } })
    if (change === "additional certificate") {
      await expect(guard()).resolves.toBeUndefined()
      expect(reads).toBe(4)
    } else {
      await expect(guard()).rejects.toThrow(/revoked|unavailable|disappeared|authority changed/i)
      expect(reads).toBe(2)
    }
  })

it("Given Identity authority keeps changing after workspace reads, when authorizing enrollment history, then stop after eight complete checks", async () => {
  const f = await signedEnrollmentFixture(), compare = local.compareAndSwapLocal
  let checks = 0, reads = 0
  vi.spyOn(local, "compareAndSwapLocal").mockImplementation(async (...args) => {
    if (!args[0].writes.length && ++checks % 2 === 0) return false
    return compare(...args)
  })
  const guard = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board"], profile: f.owner,
    remoteDeviceId: f.phone.device.deviceId, isCurrent: () => true, readProfile: async () => f.owner,
    readWorkspaces: async ids => { reads++; return ids.map(workspaceId => ({ workspaceId, credential: credential(workspaceId), authority: null })) } })
  await expect(guard()).rejects.toThrow("Identity authority changed during access check")
  expect(reads).toBe(16)
  expect(checks).toBe(16)
})

it("Given the approved same-person session and current selected credentials, when guarded, then check both devices before permitting history", async () => {
  const readCredential = vi.fn(async (id: string) => credential(id))
  const guard = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a", "board-b"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => true, readProfile: async () => profile(), readWorkspaces: snapshotReader(readCredential) })

  await expect(guard()).resolves.toBeUndefined()
  expect(new Set(readCredential.mock.calls.map(([id]) => id))).toEqual(new Set(["board-a", "board-b"]))
  expect(mocks.isDeviceRevoked).toHaveBeenCalledWith(credential("board-a"), "person-a", "approved-device")
  expect(mocks.isDeviceRevoked).toHaveBeenCalledWith(credential("board-b"), "person-a", "device-a")
})

it("Given the saved identity or device changed, when authorizing enrollment history, then refuse before serving it", async () => {
  const readCredential = vi.fn(async (id: string) => credential(id))
  const personChanged = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => true, readProfile: async () => profile("person-b"), readWorkspaces: snapshotReader(readCredential) })
  await expect(personChanged()).rejects.toThrow(/identity changed/i)
  expect(readCredential).not.toHaveBeenCalled()

  const deviceChanged = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => true, readProfile: async () => profile("person-a", "device-b"), readWorkspaces: snapshotReader(readCredential) })
  await expect(deviceChanged()).rejects.toThrow(/identity changed/i)
  expect(readCredential).not.toHaveBeenCalled()
})

it("Given a selected credential is missing or revokes the approved device, when the guard runs, then deny history access", async () => {
  const missing = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => true, readProfile: async () => profile(), readWorkspaces: snapshotReader(async () => undefined) })
  await expect(missing()).rejects.toThrow(/credential is unavailable/i)

  mocks.isDeviceRevoked.mockReturnValue(true)
  const revoked = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => true, readProfile: async () => profile(),
    readWorkspaces: snapshotReader(async id => credential(id)) })
  await expect(revoked()).rejects.toThrow(/device access revoked/i)
})

it("Given enrollment is cancelled while a credential read is pending, when the read returns, then reject before checking or serving it", async () => {
  let sessionCurrent = true
  let resolveCredential!: (value: WorkspaceMeshCredential) => void
  const readCredential = vi.fn(() => new Promise<WorkspaceMeshCredential>(resolve => { resolveCredential = resolve }))
  const guard = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => sessionCurrent, readProfile: async () => profile(), readWorkspaces: snapshotReader(readCredential) })

  const pending = guard()
  await vi.waitFor(() => expect(readCredential).toHaveBeenCalledOnce())
  sessionCurrent = false
  resolveCredential(credential("board-a"))
  await expect(pending).rejects.toThrow(/session is no longer current/i)
  expect(mocks.isDeviceRevoked).not.toHaveBeenCalled()
})
