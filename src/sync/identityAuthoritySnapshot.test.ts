import { afterEach, expect, it, vi } from "vitest"
import * as sdk from "@meta-uber/mesh-identity"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { certHashDefault } from "../domain/proofs"
import { assertLearnedIdentityDeviceActive, identityAuthorityViewKey, resolveLearnedIdentityAccess } from "../domain/identityAuthority"
import * as local from "../localDb"
import { mergeIdentityAuthorityView } from "./identityAuthorityStore"

afterEach(() => { vi.restoreAllMocks(); resetIdentityStorageForTest() })

async function fixture() {
  resetIdentityStorageForTest()
  const owner = await bootstrapIdentity("Existing authorized device")
  const phone = await sdk.createIdentityEnrollmentDevice("New phone")
  const certificate = await sdk.createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, phone.device.deviceId, phone.device.publicKey, await certHashDefault(owner.certificate))
  const profile = sdk.emptyIdentityProfileState(owner.identity.personId)
  const before = await sdk.createIdentityAuthorityView(owner.identity, { certificates: [owner.certificate], revocations: [] }, profile)
  const after = await sdk.createIdentityAuthorityView(owner.identity, { certificates: [owner.certificate, certificate], revocations: [] }, profile)
  await mergeIdentityAuthorityView(before)
  return { owner, before, after }
}

function addPhoneDuringVerification(f: Awaited<ReturnType<typeof fixture>>) {
  const authorize = sdk.authorizeIdentityDataDevice
  let changed = false
  vi.spyOn(sdk, "authorizeIdentityDataDevice").mockImplementation(async (...args) => {
    const key = await authorize(...args)
    if (!changed) { changed = true; await mergeIdentityAuthorityView(f.after) }
    return key
  })
}

it("Given the checked device stays authorized, when a phone certificate arrives during initial activity verification, then return a coherent fresh authority digest", async () => {
  const f = await fixture()
  addPhoneDuringVerification(f)
  await expect(assertLearnedIdentityDeviceActive(f.owner.identity.personId, f.owner.device.deviceId)).resolves.toBe(f.after.viewDigest)
})

it("Given the checked device stays authorized, when enrollment changes authority during initial access capture, then capture the fresh view before returning its guard", async () => {
  const f = await fixture()
  addPhoneDuringVerification(f)
  const guard = await resolveLearnedIdentityAccess([{ personId: f.owner.identity.personId, deviceId: f.owner.device.deviceId }])
  await expect(guard()).resolves.toBeUndefined()
})

it("Given an access guard already covers an in-flight operation, when a phone is added afterward, then still require that operation to reprepare", async () => {
  const f = await fixture()
  const guard = await resolveLearnedIdentityAccess([{ personId: f.owner.identity.personId, deviceId: f.owner.device.deviceId }])
  await mergeIdentityAuthorityView(f.after)
  await expect(guard()).rejects.toThrow("Identity authority changed during access check")
})

it("Given a learned view disappears during initial verification, when capture restarts, then reject instead of falling back to legacy unknown access", async () => {
  const f = await fixture(), authorize = sdk.authorizeIdentityDataDevice
  vi.spyOn(sdk, "authorizeIdentityDataDevice").mockImplementation(async (...args) => {
    const key = await authorize(...args)
    await local.deleteLocal(identityAuthorityViewKey(f.owner.identity.personId))
    return key
  })
  await expect(assertLearnedIdentityDeviceActive(f.owner.identity.personId, f.owner.device.deviceId)).rejects.toThrow(/authority.*(changed|disappeared)/i)
})

it("Given authority never settles during initial capture, when every snapshot check loses its race, then fail after a bounded number of fresh checks", async () => {
  const f = await fixture()
  const check = vi.spyOn(local, "compareAndSwapLocal").mockResolvedValue(false)
  await expect(resolveLearnedIdentityAccess([{ personId: f.owner.identity.personId, deviceId: f.owner.device.deviceId }]))
    .rejects.toThrow("Identity authority changed during access check")
  expect(check).toHaveBeenCalledTimes(8)
})
