import { beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, renameIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { certHashDefault } from "../domain/proofs"
import { defaultStorage } from "../storage"
import { saveIdentityPhoto } from "../app/identityPhoto"
import { saveIdentityName } from "../app/identityName"
import { identityProfileValue, readIdentityProfileState } from "../domain/identityProfileState"
import { applyIdentityDeviceTransfer, readIdentityDeviceTransfer } from "./identityDeviceTransfer"
import { createAuthorizedIdentityDeviceTransferFixture as createIdentityDeviceTransfer } from "./identityAuthority.testSupport"
import * as local from "../localDb"
import type { PersonalRootDocumentV1 } from "../domain/model"

beforeEach(resetIdentityStorageForTest)
const avatar = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA"
const profileState = (root: PersonalRootDocumentV1) => (root as PersonalRootDocumentV1 & { profileState?: unknown }).profileState
async function fixture() {
  const profile = await bootstrapIdentity("Original")
  const root = createPersonalRoot(profile, await certHashDefault(profile.certificate))
  root.photo = { avatarData: avatar, changedAt: "2099-01-01T00:00:00.000Z" }
  await defaultStorage.savePersonalRoot(root)
  return { profile, root }
}

it("Given a clock-skewed existing photo, when removing it, then commit its signed causal successor with the private root in one transaction", async () => {
  const f = await fixture()
  await saveIdentityPhoto(f.profile, null)
  const root = (await defaultStorage.loadPersonalRoot())!
  const state = await readIdentityProfileState(profileState(root), f.profile.identity)
  expect(state.operations).toHaveLength(1)
  expect(identityProfileValue(state, "photo")).toMatchObject({ status: "value", values: [{ avatarData: null }] })
  expect(root.photo).toBeDefined()
  expect(root.photo!.changedAt < f.root.photo!.changedAt).toBe(true)
})

it("Given a requested name change, when committing, then store signed profile evidence together with catalog and device presentation without portable private keys", async () => {
  const f = await fixture()
  await saveIdentityName("Updated", "", async () => {})
  const root = (await defaultStorage.loadPersonalRoot())!
  const state = await readIdentityProfileState(profileState(root), f.profile.identity)
  expect(identityProfileValue(state, "name")).toEqual({ status: "value", values: ["Updated"] })
  expect((await bootstrapIdentity()).identity.displayName).toBe("Updated")
  expect(root.identity.displayName).toBe("Updated")
  expect(JSON.stringify(state)).not.toMatch(/privateKeys|PrivateKeyPkcs8/)
})

it("Given signed photo removal and name update, when a receiver imports and replays an older snapshot, then keep causal values and refresh its cached name", async () => {
  const f = await fixture()
  await saveIdentityPhoto(f.profile, null)
  await saveIdentityName("Updated", "", async () => {})
  const latest = (await defaultStorage.loadPersonalRoot())!
  const manifest = await createIdentityDeviceTransfer(latest, [f.profile.certificate])
  expect(manifest.components.profileObservations.schema).toBe("profile-observations@3")
  expect(manifest.components.identityCatalog.value.personalRoot).not.toHaveProperty("profileState")
  await renameIdentity("Original")
  // Restore the recipient's pre-update storage; a stale SDK cache must follow committed incoming presentation.
  await defaultStorage.savePersonalRoot(f.root)
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(manifest, f.profile.identity.personId), () => {})
  expect((await defaultStorage.loadPersonalRoot())?.photo?.avatarData).toBeNull()
  expect((await bootstrapIdentity()).identity.displayName).toBe("Updated")
  const old = await createIdentityDeviceTransfer(f.root, [f.profile.certificate])
  await applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(old, f.profile.identity.personId), () => {})
  expect((await defaultStorage.loadPersonalRoot())?.photo?.avatarData).toBeNull()
  expect((await defaultStorage.loadPersonalRoot())?.identity.displayName).toBe("Updated")
})

it("Given profile persistence aborts, when saving signed state and local presentation, then preserve all previous bytes", async () => {
  await fixture()
  const before = await local.readLocal("tincanban.v1.personal_roots")
  const profileBefore = await local.readLocal("tincanban.local_profile.v1")
  const abort = vi.spyOn(local, "compareAndSwapLocal").mockRejectedValueOnce(new Error("transaction aborted"))
  try { await expect(saveIdentityName("Lost", "", async () => {})).rejects.toThrow("transaction aborted") }
  finally { abort.mockRestore() }
  expect(await local.readLocal("tincanban.v1.personal_roots")).toBe(before)
  expect(await local.readLocal("tincanban.local_profile.v1")).toBe(profileBefore)
})

it.each(["certificate", "private key", "missing profile"])("Given the local %s is unavailable, when a valid profile transfer arrives, then reject it before activating any component", async field => {
  const f = await fixture()
  await saveIdentityPhoto(f.profile, null)
  const latest = (await defaultStorage.loadPersonalRoot())!
  const manifest = await createIdentityDeviceTransfer(latest, [f.profile.certificate])
  await defaultStorage.savePersonalRoot(f.root)
  const key = "tincanban.local_profile.v1", raw = JSON.parse((await local.readLocal(key))!) as {
    certificate: unknown; privateKeys: { devicePrivateKeyPkcs8: string }
  }
  if (field === "certificate") raw.certificate = null
  else if (field === "private key") raw.privateKeys.devicePrivateKeyPkcs8 = "invalid key bytes"
  if (field === "missing profile") await local.deleteLocal(key)
  else await local.writeLocal(key, JSON.stringify(raw))
  const keys = [key, "tincanban.v1.personal_roots", `tincanban.identity-device-activation.v1.${f.profile.identity.personId}`]
  const before = await Promise.all(keys.map(local.readLocal))
  await expect(applyIdentityDeviceTransfer(await readIdentityDeviceTransfer(manifest, f.profile.identity.personId), () => {})).rejects.toThrow()
  const after = await Promise.all(keys.map(local.readLocal))
  expect(after.every((raw, index) => raw === before[index])).toBe(true)
})
