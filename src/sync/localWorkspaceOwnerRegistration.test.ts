import { beforeEach, expect, it, vi } from "vitest"
const f = vi.hoisted(() => ({ authority: vi.fn(), validate: vi.fn(), status: vi.fn(), local: vi.fn(), active: vi.fn(), publish: vi.fn(), context: vi.fn(), sign: vi.fn() }))
vi.mock("./peerStore", () => ({ peerStore: { getWorkspaceAuthority: f.authority } }))
vi.mock("./identityAuthorityStore", () => ({ requireIdentityAuthorityView: f.local }))
vi.mock("@meta-uber/mesh-identity", () => ({ authorizeIdentityDataDevice: f.active }))
vi.mock("@meta-uber/mesh-replication/runtime", () => ({ meshRustRuntime: () => ({ state: { validateScopeAuthority: f.validate } }) }))
vi.mock("@meta-uber/mesh-replication/rusty-identity-authority", () => ({ publishRustyIdentityAuthorityView: f.publish, readRustyIdentityAuthorityStatus: f.status }))
vi.mock("../domain/identity", () => ({ canonicalizeJson: JSON.stringify }))
vi.mock("../domain/localSigningContext", () => ({ resolveLocalSigningContext: f.context }))
vi.mock("../domain/signingContext", () => ({ signWithContext: f.sign }))
import { registerLocalWorkspaceOwners } from "./localWorkspaceOwnerRegistration"
const profile = { identity: { personId: "bo", publicKey: "bo-root" }, device: { deviceId: "same-app-device", publicKey: "same-app-key" } }
const config = { workspaceId: "board", origin: "https://rusty.example", servicePublicKey: "pin" }
beforeEach(() => {
  vi.clearAllMocks()
  f.authority.mockResolvedValue({ ownerPersonId: "bo", ownerPublicKey: "bo-root", scopeAuthoritySnapshot: { controlTransfers: [] } })
  f.validate.mockReturnValue({ creator: { personId: "guest", publicKey: "guest-root" }, controller: profile.identity })
  f.status.mockResolvedValue({ payload: { state: "missing" } })
  f.local.mockResolvedValue({ personId: "guest", identityPublicKey: "guest-root", viewDigest: "guest-view" })
  f.active.mockResolvedValue("same-app-key")
  f.context.mockImplementation(async (_profile, _purpose, _binding, options) => {
    await options.ensureCurrent()
    await options.currentAuthority()
    return { guarded: "current Bo signing context" }
  })
  f.publish.mockResolvedValue({})
})
it("Given an unshared local board transferred to Bo, when connecting Rusty, then register its prior authority using the same still-certified app key and current profile guard", async () => {
  await registerLocalWorkspaceOwners(profile as never, config as never, () => {})
  const options = f.publish.mock.calls[0]![0]
  expect(options.identity.personId).toBe("guest")
  expect(options.deviceId).toBe(profile.device.deviceId)
  const payload = { kind: "rusty-identity-authority-update", personId: "guest", origin: config.origin, serviceId: "service", viewDigest: "guest-view" }
  await options.signAuthorization(payload)
  expect(f.context.mock.calls[0]?.[0]).toBe(profile)
  expect(f.context.mock.calls[0]?.[2]).toMatchObject({ personId: "guest", viewDigest: "guest-view", origin: config.origin })
  expect(f.sign).toHaveBeenCalledWith({ guarded: "current Bo signing context" }, payload)
})
it("Given prior owner authority is already registered, when connecting, then never publish a cached replacement", async () => {
  f.status.mockResolvedValue({ payload: { state: "ready" } })
  await registerLocalWorkspaceOwners(profile as never, config as never, () => {})
  expect(f.publish).not.toHaveBeenCalled()
  expect(f.local).not.toHaveBeenCalled()
})
it("Given this app key is not authorized by the former owner, when connecting, then reject without a publication", async () => {
  f.active.mockResolvedValue("another-key")
  await expect(registerLocalWorkspaceOwners(profile as never, config as never, () => {})).rejects.toThrow("device that transferred")
  expect(f.publish).not.toHaveBeenCalled()
})
it("Given workspace ownership changed, when the explicit connection runs, then reject before any authority I/O", async () => {
  f.validate.mockReturnValue({ creator: { personId: "guest", publicKey: "guest-root" }, controller: { personId: "other", publicKey: "other-root" } })
  await expect(registerLocalWorkspaceOwners(profile as never, config as never, () => {})).rejects.toThrow("does not control")
  expect(f.status).not.toHaveBeenCalled()
})

it("Given the former owner's authority advances during registration, when signing the publication, then reject the stale view", async () => {
  await registerLocalWorkspaceOwners(profile as never, config as never, () => {})
  f.local.mockResolvedValue({ personId: "guest", identityPublicKey: "guest-root", viewDigest: "revoked-guest-view" })
  const payload = { kind: "rusty-identity-authority-update", personId: "guest", origin: config.origin, serviceId: "service", viewDigest: "guest-view" }
  await expect(f.publish.mock.calls[0]![0].signAuthorization(payload)).rejects.toThrow("Previous local owner authority changed")
  expect(f.sign).not.toHaveBeenCalled()
})
