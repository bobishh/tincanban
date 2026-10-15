import { beforeEach, expect, it, vi } from "vitest"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceMeshCredential } from "./peerStore"

const mocks = vi.hoisted(() => ({ isDeviceRevoked: vi.fn() }))
vi.mock("./durableMeshBase", () => ({ isDeviceRevoked: mocks.isDeviceRevoked }))

import { createEnrollmentHistoryAuthorizationGuard } from "./enrollmentHistoryAuthorization"

const profile = (personId = "person-a", deviceId = "device-a") => ({
  identity: { personId, publicKey: "public-key", displayName: "Owner" },
  device: { deviceId, publicKey: "device-key", displayName: "Owner device" },
  privateKeys: { devicePrivateKey: {} }, certificate: {},
} as unknown as LocalProfile)

const credential = (workspaceId: string) => ({ version: 1, workspaceId } as unknown as WorkspaceMeshCredential)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.isDeviceRevoked.mockReturnValue(false)
})

it("Given the approved same-person session and current selected credentials, when guarded, then permit only after native revocation checks", async () => {
  const readCredential = vi.fn(async (id: string) => credential(id))
  const guard = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a", "board-b"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => true, readProfile: async () => profile(), readCredential })

  await expect(guard()).resolves.toBeUndefined()
  expect(readCredential).toHaveBeenCalledTimes(2)
  expect(mocks.isDeviceRevoked).toHaveBeenNthCalledWith(1, credential("board-a"), "person-a", "approved-device")
  expect(mocks.isDeviceRevoked).toHaveBeenNthCalledWith(2, credential("board-b"), "person-a", "approved-device")
})

it("Given the saved identity or device changed, when authorizing enrollment history, then refuse before serving it", async () => {
  const readCredential = vi.fn(async (id: string) => credential(id))
  const personChanged = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => true, readProfile: async () => profile("person-b"), readCredential })
  await expect(personChanged()).rejects.toThrow(/identity changed/i)
  expect(readCredential).not.toHaveBeenCalled()

  const deviceChanged = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => true, readProfile: async () => profile("person-a", "device-b"), readCredential })
  await expect(deviceChanged()).rejects.toThrow(/identity changed/i)
  expect(readCredential).not.toHaveBeenCalled()
})

it("Given a selected credential is missing or revokes the approved device, when the guard runs, then deny history access", async () => {
  const missing = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => true, readProfile: async () => profile(), readCredential: async () => undefined })
  await expect(missing()).rejects.toThrow(/credential is unavailable/i)

  mocks.isDeviceRevoked.mockReturnValue(true)
  const revoked = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => true, readProfile: async () => profile(),
    readCredential: async id => credential(id) })
  await expect(revoked()).rejects.toThrow(/device access revoked/i)
})

it("Given enrollment is cancelled while a credential read is pending, when the read returns, then reject before checking or serving it", async () => {
  let sessionCurrent = true
  let resolveCredential!: (value: WorkspaceMeshCredential) => void
  const readCredential = vi.fn(() => new Promise<WorkspaceMeshCredential>(resolve => { resolveCredential = resolve }))
  const guard = createEnrollmentHistoryAuthorizationGuard({ workspaceIds: ["board-a"], profile: profile(),
    remoteDeviceId: "approved-device", isCurrent: () => sessionCurrent, readProfile: async () => profile(), readCredential })

  const pending = guard()
  await vi.waitFor(() => expect(readCredential).toHaveBeenCalledOnce())
  sessionCurrent = false
  resolveCredential(credential("board-a"))
  await expect(pending).rejects.toThrow(/session is no longer current/i)
  expect(mocks.isDeviceRevoked).not.toHaveBeenCalled()
})
