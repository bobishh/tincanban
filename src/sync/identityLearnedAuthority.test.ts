import { afterEach, expect, it, vi } from "vitest"
import * as sdk from "@meta-uber/mesh-identity"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { certHashDefault } from "../domain/proofs"
import { assertLearnedIdentityDeviceActive, identityAuthorityViewKey, resolveLearnedIdentityAccess } from "../domain/identityAuthority"
import { writeLocal } from "../localDb"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"
import { assertIdentityDevicePrivateExchangeAllowed } from "./identityDevicePrivateExchange"
import { RustyManagementRepository } from "./rustyManagementRepository"

afterEach(() => vi.restoreAllMocks())

async function fixture() {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Authority owner")
  const values = new Map<string, string>()
  const remote = await new sdk.BrowserIdentityStore({ storageKey: "authority-remote-app", storage: {
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) },
    removeItem: key => { values.delete(key) },
  } }).bootstrap("Remote app")
  const certificate = await sdk.createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, remote.device.deviceId, remote.device.publicKey, await certHashDefault(owner.certificate))
  const certificates = [owner.certificate, certificate], profile = sdk.emptyIdentityProfileState(owner.identity.personId)
  const authority = await sdk.verifyIdentityDeviceAuthority(owner.identity, { certificates, revocations: [] })
  const revoked = await sdk.createDeviceRevocation(owner, authority, remote.device.deviceId, profile)
  const active = await sdk.createIdentityAuthorityView(owner.identity, { certificates, revocations: [] }, profile)
  const removed = await sdk.createIdentityAuthorityView(owner.identity, { certificates, revocations: [revoked] }, profile)
  return { owner, remote, active, removed }
}

it("Given no learned Identity view, when the existing legacy activity check runs, then retain its explicit unknown result", async () => {
  const f = await fixture()
  await expect(assertLearnedIdentityDeviceActive(f.owner.identity.personId, f.remote.device.deviceId)).resolves.toBeNull()
})

it("Given an unknown Identity view at capture, when a signed revocation arrives before disclosure, then the captured guard cannot retain legacy access", async () => {
  const f = await fixture()
  const assertCurrentAuthority = await resolveLearnedIdentityAccess([{ personId: f.owner.identity.personId, deviceId: f.remote.device.deviceId }])
  await mergeIdentityAuthorityView(f.removed)
  await expect(assertCurrentAuthority()).rejects.toThrow(/Identity device access is revoked/i)
})

it("Given malformed learned authority, when a device access check is requested, then fail instead of using legacy unknown access", async () => {
  const f = await fixture()
  await writeLocal(identityAuthorityViewKey(f.owner.identity.personId), "{invalid")
  await expect(resolveLearnedIdentityAccess([{ personId: f.owner.identity.personId, deviceId: f.remote.device.deviceId }]))
    .rejects.toThrow("Stored Identity authority view is malformed")
})

it("Given verified learned global authority, when checking an active then revoked app, then return its digest only while that device remains authorized", async () => {
  const f = await fixture()
  await mergeIdentityAuthorityView(f.active)
  await expect(assertLearnedIdentityDeviceActive(f.owner.identity.personId, f.remote.device.deviceId)).resolves.toBe(f.active.viewDigest)
  await mergeIdentityAuthorityView(f.removed)
  await expect(assertLearnedIdentityDeviceActive(f.owner.identity.personId, f.remote.device.deviceId)).rejects.toThrow(/Identity device access is revoked/i)
})

it("Given authority changes during device authorization, when the earlier verified check completes, then reject its stale activity result", async () => {
  const f = await fixture()
  await mergeIdentityAuthorityView(f.active)
  const authorize = sdk.authorizeIdentityDataDevice
  vi.spyOn(sdk, "authorizeIdentityDataDevice").mockImplementation(async (...args) => {
    const key = await authorize(...args)
    await mergeIdentityAuthorityView(f.removed)
    return key
  })
  await expect(assertLearnedIdentityDeviceActive(f.owner.identity.personId, f.remote.device.deviceId))
    .rejects.toThrow(/Identity.*(changed|revoked|unavailable)/i)
})

it("Given global Identity revocation arrives while Rusty policies are being read, when private exchange authorization completes, then reject its stale global access result", async () => {
  const f = await fixture()
  await mergeIdentityAuthorityView(f.active)
  const read = RustyManagementRepository.prototype.export
  vi.spyOn(RustyManagementRepository.prototype, "export").mockImplementation(async function (this: RustyManagementRepository) {
    const policies = await read.call(this)
    await mergeIdentityAuthorityView(f.removed)
    return policies
  })
  await expect(assertIdentityDevicePrivateExchangeAllowed(f.owner, f.remote.device.deviceId)).rejects.toThrow(/Identity.*(changed|revoked|unavailable)/i)
})
