import { beforeEach, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { createPersonalRoot } from "./personalRoot"
import { resolveSigningContext } from "./signingContext"
import { certHashDefault, createDelegatedCertificate } from "./proofs"
import { mergeIdentityProfileState, createIdentityProfileOperation, emptyIdentityProfileState,
  identityProfileValue, observeLegacyIdentityProfile } from "./identityProfileState"
import { reconcileIdentityProfileRootPresentation, rootIdentityProfileState } from "./identityProfileRoot"

beforeEach(resetIdentityStorageForTest)

async function context(profile: LocalProfile, certificates = [profile.certificate]) {
  return resolveSigningContext({ profile, certificates, purpose: "identity-profile-update",
    binding: { personId: profile.identity.personId }, authorityRevision: "current", current: async () => ({
      personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: "current",
    }) })
}

async function secondContext(owner: LocalProfile) {
  resetIdentityStorageForTest()
  const fresh = await bootstrapIdentity("Second device")
  const certificate = await createDelegatedCertificate(owner.privateKeys.devicePrivateKey, owner.device.deviceId,
    owner.identity.personId, fresh.device.deviceId, fresh.device.publicKey, await certHashDefault(owner.certificate))
  const profile = { ...fresh, identity: owner.identity, certificate, privateKeys: { devicePrivateKey: fresh.privateKeys.devicePrivateKey } }
  return context(profile, [certificate, owner.certificate])
}

it("Given concurrent signed name and photo values, when reading the root presentation, then require every saved shadow to match retained history", async () => {
  const owner = await bootstrapIdentity("Owner")
  const first = await context(owner)
  const second = await secondContext(owner)
  const base = emptyIdentityProfileState(owner.identity.personId)
  const nameA = await createIdentityProfileOperation(first, base, owner.identity, "name", "Alpha")
  const nameB = await createIdentityProfileOperation(second, base, owner.identity, "name", "Beta")
  const photoA = await createIdentityProfileOperation(first, { ...base, operations: [nameA] }, owner.identity, "photo", {
    avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2001-01-01T00:00:00.000Z" })
  const photoB = await createIdentityProfileOperation(second, { ...base, operations: [nameB] }, owner.identity, "photo", {
    avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAAAA==", changedAt: "2002-01-01T00:00:00.000Z" })
  const state = await mergeIdentityProfileState({ ...base, operations: [nameA, photoA] },
    { ...base, operations: [nameB, photoB] }, owner.identity)
  expect(identityProfileValue(state, "name").status).toBe("conflict")
  expect(identityProfileValue(state, "photo").status).toBe("conflict")

  const root = { ...createPersonalRoot(owner, "A".repeat(43)), profileState: state,
    photo: identityProfileValue(state, "photo").values[0] as { avatarData: string | null; changedAt: string } }
  root.identity.displayName = "Alpha"
  await expect(rootIdentityProfileState(root)).resolves.toEqual(state)

  const unsignedName = structuredClone(root)
  unsignedName.identity.displayName = "Unrecorded"
  await expect(rootIdentityProfileState(unsignedName)).rejects.toThrow(/presentation.*history/i)
  await expect(reconcileIdentityProfileRootPresentation(unsignedName)).rejects.toThrow(/presentation.*history/i)

  const unsignedPhoto = structuredClone(root)
  unsignedPhoto.photo = { avatarData: null, changedAt: "2099-01-01T00:00:00.000Z" }
  await expect(rootIdentityProfileState(unsignedPhoto)).rejects.toThrow(/presentation.*history/i)
  await expect(reconcileIdentityProfileRootPresentation(unsignedPhoto)).rejects.toThrow(/presentation.*history/i)
})

it("Given a root shadow changed by device adoption, when reconciling it, then restore only uniquely signed presentation and retain all profile evidence", async () => {
  const owner = await bootstrapIdentity("Original")
  const context = await resolveSigningContext({ profile: owner, certificates: [owner.certificate], purpose: "identity-profile-update",
    binding: { personId: owner.identity.personId }, authorityRevision: "current", current: async () => ({
      personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision: "current",
    }) })
  let profileState = await observeLegacyIdentityProfile(emptyIdentityProfileState(owner.identity.personId), owner.identity,
    "name", "Original")
  const renamed = await createIdentityProfileOperation(context, profileState, owner.identity, "name", "Signed name")
  profileState = { ...profileState, operations: [renamed] }
  const pictured = await createIdentityProfileOperation(context, profileState, owner.identity, "photo", {
    avatarData: null, changedAt: "2026-10-20T10:00:00.000Z",
  })
  profileState = { ...profileState, operations: [renamed, pictured] }
  const root = { ...createPersonalRoot(owner, "A".repeat(43)), profileState }
  root.identity.displayName = "Portal device label"
  const originalHistory = structuredClone(root.profileState)

  const repaired = await reconcileIdentityProfileRootPresentation(root)

  expect(repaired.identity.personId).toBe(owner.identity.personId)
  expect(repaired.identity.publicKey).toBe(owner.identity.publicKey)
  expect(repaired.identity.displayName).toBe("Signed name")
  expect(repaired.photo).toEqual({ avatarData: null, changedAt: "2026-10-20T10:00:00.000Z" })
  expect(repaired.profileState).toEqual(originalHistory)
  await expect(rootIdentityProfileState(repaired)).resolves.toEqual(profileState)
  expect(root.profileState).toEqual(originalHistory)
})
