import { beforeEach, expect, it } from "vitest"
import { adoptEnrolledIdentity, bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { resolveSigningContext } from "../domain/signingContext"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault, createDelegatedCertificate, defaultProofStore } from "../domain/proofs"
import { createIdentityProfileOperation, emptyIdentityProfileState, identityProfileValue, observeLegacyIdentityProfile } from "../domain/identityProfileState"
import { projectIdentityProfileRoot, rootIdentityProfileState } from "../domain/identityProfileRoot"
import { defaultStorage } from "../storage"
import * as local from "../localDb"
import { applyIdentityDeviceTransfer, createIdentityDeviceTransfer, readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import type { LocalProfile } from "../domain/identity"
import type { PersonalRootDocumentV1 } from "../domain/model"
import { isAvatarDataUrl } from "../domain/avatarData"

beforeEach(() => resetIdentityStorageForTest())

async function fixture() {
  const profile = await bootstrapIdentity("Original")
  const root = createPersonalRoot(profile, await certHashDefault(profile.certificate))
  await defaultStorage.savePersonalRoot(root)
  return { profile, root }
}

function identityObservation(manifest: Awaited<ReturnType<typeof createIdentityDeviceTransfer>>) {
  const componentValue = manifest.components.profileObservations.value as { observations: Array<{
    kind: "identity-profile"; displayName: string; photo?: unknown; profileState?: {
      operations: Array<{ signed: { payload: { value: unknown } } }>
    }
  }> }
  return componentValue.observations[0]
}

it("Given conflicting name history, when both unsigned name shadows contain an unrecorded value, then reject that presentation", async () => {
  const f = await fixture(), state = await rootIdentityProfileState(f.root)
  f.root.profileState = await observeLegacyIdentityProfile(state, f.profile.identity, "name", "Other name")
  const manifest = await createIdentityDeviceTransfer(f.root, [f.profile.certificate])
  const catalog = manifest.components.identityCatalog.value.personalRoot as PersonalRootDocumentV1
  catalog.identity.displayName = "Unrecorded name"
  identityObservation(manifest).displayName = "Unrecorded name"
  await expect(readIdentityDeviceTransfer(manifest, f.profile.identity.personId)).rejects.toThrow(/presentation.*history/i)
})

it("Given conflicting photo history, when its unsigned shadow contains an unrecorded photo, then reject that presentation", async () => {
  const f = await fixture()
  f.root.photo = { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2026-01-01T00:00:00.000Z" }
  f.root.profileState = await observeLegacyIdentityProfile(await rootIdentityProfileState(f.root), f.profile.identity,
    "photo", { avatarData: null, changedAt: "2026-01-02T00:00:00.000Z" })
  const manifest = await createIdentityDeviceTransfer(f.root, [f.profile.certificate])
  const unrecorded = { avatarData: `${f.root.photo.avatarData}AA==`, changedAt: "2026-01-03T00:00:00.000Z" }
  expect(isAvatarDataUrl(unrecorded.avatarData)).toBe(true)
  identityObservation(manifest).photo = unrecorded
  await expect(readIdentityDeviceTransfer(manifest, f.profile.identity.personId)).rejects.toThrow(/presentation.*history/i)
})

it("Given the required causal name history is absent, when a name shadow is supplied, then reject the incomplete transfer", async () => {
  const f = await fixture(), manifest = await createIdentityDeviceTransfer(f.root, [f.profile.certificate])
  identityObservation(manifest).profileState = emptyIdentityProfileState(f.profile.identity.personId)
  await expect(readIdentityDeviceTransfer(manifest, f.profile.identity.personId)).rejects.toThrow(/presentation.*history/i)
})

it("Given legacy profile observation schemas 1 and 2, when reading a device transfer, then retain original values without inventing signed counters", async () => {
  const f = await fixture()
  for (const schema of ["profile-observations@1", "profile-observations@2"]) {
    const manifest = await createIdentityDeviceTransfer(f.root, [f.profile.certificate])
    manifest.components.profileObservations.schema = schema
    const observation = identityObservation(manifest)
    delete observation.profileState
    const parsed = await readIdentityDeviceTransfer(manifest, f.profile.identity.personId)
    expect(parsed.personalRoot.identity.displayName).toBe("Original")
    expect(parsed.personalRoot.profileState?.operations).toEqual([])
    expect(parsed.personalRoot.profileState?.legacy).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "name", value: "Original" }),
    ]))
    expect(parsed.personalRoot.profileState?.legacy[0]).not.toHaveProperty("counter")
    await applyIdentityDeviceTransfer(parsed, () => {})
  }
  expect((await defaultStorage.loadPersonalRoot(f.root.rootId))?.identity.displayName).toBe("Original")
})

it("Given state hidden in an older required schema or missing from schema 3, when preflighting, then require upgrade before any activation", async () => {
  const f = await fixture()
  const current = await createIdentityDeviceTransfer(f.root, [f.profile.certificate])
  const before = await local.readLocal("tincanban.v1.personal_roots")

  const hidden = structuredClone(current)
  hidden.components.profileObservations.schema = "profile-observations@2"
  await expect(readIdentityDeviceTransfer(hidden, f.profile.identity.personId))
    .rejects.toMatchObject({ code: "identity-device-state-upgrade-required" })

  const missing = structuredClone(current)
  delete identityObservation(missing).profileState
  await expect(readIdentityDeviceTransfer(missing, f.profile.identity.personId))
    .rejects.toMatchObject({ code: "identity-device-state-upgrade-required" })
  expect(await local.readLocal("tincanban.v1.personal_roots")).toBe(before)
})

it("Given a signed operation or its presentation shadow is tampered, when preflighting, then reject before catalog or private preferences change", async () => {
  const f = await fixture()
  const state = emptyIdentityProfileState(f.profile.identity.personId)
  const context = await resolveSigningContext({ profile: f.profile, certificates: [f.profile.certificate],
    purpose: "identity-profile-update", binding: { personId: f.profile.identity.personId }, authorityRevision: "current",
    current: async () => ({ personId: f.profile.identity.personId, deviceId: f.profile.device.deviceId, authorityRevision: "current" }) })
  const operation = await createIdentityProfileOperation(context, state, f.profile.identity, "name", "Signed name")
  const withUpdate = projectIdentityProfileRoot(f.root, { ...state, operations: [operation] })
  const valid = await createIdentityDeviceTransfer(withUpdate, [f.profile.certificate])
  const rootsBefore = await local.readLocal("tincanban.v1.personal_roots")
  const replicasKey = `tincanban.private-replica-state.v2.${f.profile.identity.personId}`
  const replicasBefore = await local.readLocal(replicasKey)

  const forgedOperation = structuredClone(valid)
  identityObservation(forgedOperation).profileState!.operations[0].signed.payload.value = "Forged name"
  const forged = await readIdentityDeviceTransfer(forgedOperation, f.profile.identity.personId).catch(error => error)
  expect(forged).toBeInstanceOf(Error)
  expect(String(forged)).toMatch(/signature/i)

  const shadowMismatch = structuredClone(valid)
  identityObservation(shadowMismatch).displayName = "Different unsigned name"
  await expect(readIdentityDeviceTransfer(shadowMismatch, f.profile.identity.personId)).rejects.toThrow(/profile identity mismatch|presentation/i)
  expect(await local.readLocal("tincanban.v1.personal_roots")).toBe(rootsBefore)
  expect(await local.readLocal(replicasKey)).toBe(replicasBefore)
})

it("Given newer local causal profile state, when importing a valid transfer, then fail atomically and preserve root and profile bytes", async () => {
  const f = await fixture()
  const transfer = await readIdentityDeviceTransfer(await createIdentityDeviceTransfer(f.root, [f.profile.certificate]), f.profile.identity.personId)
  const newer = { ...f.root, profileState: { version: 2, personId: f.profile.identity.personId, future: "retained" } } as unknown as PersonalRootDocumentV1
  await defaultStorage.savePersonalRoot(newer)
  const rootBytes = await local.readLocal("tincanban.v1.personal_roots")
  const profileBytes = await local.readLocal("tincanban.local_profile.v1")
  await expect(applyIdentityDeviceTransfer(transfer, () => {})).rejects.toMatchObject({ code: "identity-profile-upgrade-required" })
  expect(await local.readLocal("tincanban.v1.personal_roots")).toBe(rootBytes)
  expect(await local.readLocal("tincanban.local_profile.v1")).toBe(profileBytes)
})

it("Given independently signed concurrent updates from two certified devices, when both snapshots are imported, then preserve conflict and committed shadow without choosing a winner", async () => {
  const f = await fixture()
  resetIdentityStorageForTest()
  const second = await bootstrapIdentity("Second device")
  const delegated = await createDelegatedCertificate(f.profile.privateKeys.devicePrivateKey!, f.profile.device.deviceId,
    f.profile.identity.personId, second.device.deviceId, second.device.publicKey, await certHashDefault(f.profile.certificate))
  const secondProfile: LocalProfile = { ...second, identity: f.profile.identity, certificate: delegated,
    privateKeys: { devicePrivateKey: second.privateKeys.devicePrivateKey } }
  await defaultStorage.savePersonalRoot(f.root)
  const firstContext = await resolveSigningContext({ profile: f.profile, certificates: [f.profile.certificate],
    purpose: "identity-profile-update", binding: { personId: f.profile.identity.personId }, authorityRevision: "current",
    current: async () => ({ personId: f.profile.identity.personId, deviceId: f.profile.device.deviceId, authorityRevision: "current" }) })
  const secondContext = await resolveSigningContext({ profile: secondProfile, certificates: [delegated, f.profile.certificate],
    purpose: "identity-profile-update", binding: { personId: f.profile.identity.personId }, authorityRevision: "current",
    current: async () => ({ personId: f.profile.identity.personId, deviceId: second.device.deviceId, authorityRevision: "current" }) })
  const base = await rootIdentityProfileState(f.root)
  const left = await createIdentityProfileOperation(firstContext, base, f.profile.identity, "name", "Alpha")
  const right = await createIdentityProfileOperation(secondContext, base, f.profile.identity, "name", "Beta")
  const leftRoot = projectIdentityProfileRoot(f.root, { ...base, operations: [left] })
  const rightRoot = projectIdentityProfileRoot(f.root, { ...base, operations: [right] })
  const leftTransfer = await readIdentityDeviceTransfer(await createIdentityDeviceTransfer(leftRoot, [f.profile.certificate]), f.profile.identity.personId)
  const rightTransfer = await readIdentityDeviceTransfer(await createIdentityDeviceTransfer(rightRoot, [f.profile.certificate, delegated]), f.profile.identity.personId)

  resetIdentityStorageForTest()
  const freshReceiver = await bootstrapIdentity("Receiver")
  const receiverCertificate = await createDelegatedCertificate(f.profile.privateKeys.devicePrivateKey, f.profile.device.deviceId,
    f.profile.identity.personId, freshReceiver.device.deviceId, freshReceiver.device.publicKey, await certHashDefault(f.profile.certificate))
  await defaultProofStore.putCertificate(await certHashDefault(f.profile.certificate), f.profile.certificate)
  await defaultProofStore.putCertificate(await certHashDefault(receiverCertificate), receiverCertificate)
  await adoptEnrolledIdentity(f.profile.identity, receiverCertificate)
  const receiver = await bootstrapIdentity()
  expect(receiver.privateKeys.identityPrivateKey).toBeUndefined()
  const localRoot = structuredClone(f.root)
  Object.assign(localRoot.devices, createPersonalRoot(receiver, await certHashDefault(receiverCertificate)).devices)
  await defaultStorage.savePersonalRoot(localRoot)
  await applyIdentityDeviceTransfer(leftTransfer, () => {})
  await applyIdentityDeviceTransfer(rightTransfer, () => {})
  const committed = await defaultStorage.loadPersonalRoot(f.root.rootId) as PersonalRootDocumentV1
  expect(identityProfileValue(await rootIdentityProfileState(committed), "name")).toEqual({ status: "conflict", values: ["Alpha", "Beta"] })
  expect(committed.identity.displayName).toBe("Alpha")
})
