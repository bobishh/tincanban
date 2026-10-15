import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { editIdentityProfileRoot, rootIdentityProfileState } from "../domain/identityProfileRoot"
import { identityProfileRevision } from "../domain/identityProfileRevision"
import { identityProfileValue, readIdentityProfileState } from "../domain/identityProfileState"
import { defaultStorage } from "../storage"
import * as local from "../localDb"
import { saveIdentityName } from "./identityName"
import { saveIdentityPhoto } from "./identityPhoto"
import { subscribeIdentityDevicePreferences } from "../sync/identityDevicePreferenceEvents"

const rootKey = "tincanban.v1.personal_roots", profileKey = "tincanban.local_profile.v1"
beforeEach(resetIdentityStorageForTest)
afterEach(() => { vi.restoreAllMocks() })

async function fixture() {
  const profile = await bootstrapIdentity("Original")
  const root = createPersonalRoot(profile, "certificate")
  root.photo = { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2099-01-01T00:00:00.000Z" }
  await defaultStorage.savePersonalRoot(root)
  return { profile, root, revision: await identityProfileRevision(await rootIdentityProfileState(root)) }
}

it("Given one name and photo draft, when Save commits, then publish both signed values and cached name after one atomic transaction", async () => {
  const f = await fixture(), compare = local.compareAndSwapLocal.bind(local)
  const cas = vi.spyOn(local, "compareAndSwapLocal").mockImplementation(compare)
  const notified: Array<Promise<unknown>> = []
  const unsubscribe = subscribeIdentityDevicePreferences(() => { notified.push(defaultStorage.loadPersonalRoot()) })
  try { await saveIdentityName("Chosen", "", async () => {}, { avatarData: null, expectedRevision: f.revision }) }
  finally { unsubscribe() }
  const root = (await defaultStorage.loadPersonalRoot())!, state = await readIdentityProfileState(root.profileState, f.profile.identity)
  expect(identityProfileValue(state, "name")).toEqual({ status: "value", values: ["Chosen"] })
  expect(identityProfileValue(state, "photo")).toMatchObject({ status: "value", values: [{ avatarData: null }] })
  expect(state.operations).toHaveLength(2)
  expect(state.legacy).toHaveLength(2)
  expect(cas.mock.calls.filter(([plan]) => plan.writes.some(write => write.key === profileKey))).toHaveLength(1)
  expect((await bootstrapIdentity()).identity.displayName).toBe("Chosen")
  expect(notified).toHaveLength(1)
  await expect(notified[0]).resolves.toMatchObject({ identity: { displayName: "Chosen" }, photo: { avatarData: null } })
})

it("Given combined save storage aborts, when committing, then keep exact prior profile and catalog bytes without notification", async () => {
  const f = await fixture(), previous = await Promise.all([local.readLocal(rootKey), local.readLocal(profileKey)])
  vi.spyOn(local, "compareAndSwapLocal").mockRejectedValueOnce(new Error("atomic storage failure"))
  const changed = vi.fn(), unsubscribe = subscribeIdentityDevicePreferences(changed)
  try { await expect(saveIdentityName("Lost", "", async () => {}, { avatarData: null, expectedRevision: f.revision })).rejects.toThrow("atomic storage failure") }
  finally { unsubscribe() }
  expect(await Promise.all([local.readLocal(rootKey), local.readLocal(profileKey)])).toEqual(previous)
  expect((await bootstrapIdentity()).identity.displayName).toBe("Original")
  expect(changed).not.toHaveBeenCalled()
})

it("Given an unseen signed profile revision, when saving an older draft, then reject it without changing either field", async () => {
  const f = await fixture()
  await saveIdentityPhoto(f.profile, null)
  const previous = await Promise.all([local.readLocal(rootKey), local.readLocal(profileKey)])
  await expect(saveIdentityName("Stale", "", async () => {}, { avatarData: f.root.photo!.avatarData, expectedRevision: f.revision })).rejects.toThrow(/profile changed.*review/i)
  expect(await Promise.all([local.readLocal(rootKey), local.readLocal(profileKey)])).toEqual(previous)
})

it("Given a profile update wins while Save is committing, when CAS retries, then require reviewing that revision instead of superseding unseen values", async () => {
  const f = await fixture(), compare = local.compareAndSwapLocal.bind(local)
  let raced = false
  vi.spyOn(local, "compareAndSwapLocal").mockImplementation(async (plan, ensureCurrent) => {
    if (!raced && plan.writes.some(write => write.key === profileKey)) {
      raced = true
      await defaultStorage.updatePersonalRootForIdentity(f.profile.identity.personId, async root => {
        if (!root) throw new Error("Root disappeared")
        return editIdentityProfileRoot(root, f.profile, "photo", { avatarData: null, changedAt: "2026-01-01T00:00:00.000Z" })
      })
    }
    return compare(plan, ensureCurrent)
  })
  await expect(saveIdentityName("Stale", "", async () => {}, { avatarData: f.root.photo!.avatarData, expectedRevision: f.revision })).rejects.toThrow(/profile changed.*review/i)
  expect(raced).toBe(true)
  expect((await defaultStorage.loadPersonalRoot())?.photo?.avatarData).toBeNull()
  expect((await bootstrapIdentity()).identity.displayName).toBe("Original")
})

it("Given already signed equal values, when Save repeats without a draft change, then preserve signed history and counters", async () => {
  const f = await fixture()
  await saveIdentityName("Chosen", "", async () => {}, { avatarData: null, expectedRevision: f.revision })
  const root = (await defaultStorage.loadPersonalRoot())!, before = root.profileState
  await saveIdentityName("Chosen", "", async () => {}, { avatarData: null, expectedRevision: await identityProfileRevision(before!) })
  expect((await defaultStorage.loadPersonalRoot())?.profileState).toEqual(before)
})
