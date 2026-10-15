import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { deleteLocal, readLocal } from "../localDb"
import * as localDb from "../localDb"
import { defaultStorage } from "../storage"
import { saveIdentityName } from "./identityName"
import { subscribeIdentityDevicePreferences } from "../sync/identityDevicePreferenceEvents"

const rootsKey = "tincanban.v1.personal_roots"
const profileKey = "tincanban.local_profile.v1"

beforeEach(async () => {
  resetIdentityStorageForTest()
  await deleteLocal(rootsKey)
})

afterEach(() => { vi.restoreAllMocks() })

it("Given the personal root is missing, when a rename is requested, then leave cached and durable profile unchanged", async () => {
  const before = await bootstrapIdentity("Original")
  const rawBefore = await readLocal(profileKey)

  await expect(saveIdentityName("Changed", "active", async () => {})).rejects.toThrow(/personal root.*missing/i)

  expect(await readLocal(profileKey)).toBe(rawBefore)
  expect((await bootstrapIdentity()).identity.displayName).toBe(before.identity.displayName)
})

it("Given the atomic rename commit aborts, when saving a name, then preserve both cached profile and root", async () => {
  const profile = await bootstrapIdentity("Original")
  await defaultStorage.savePersonalRoot(createPersonalRoot(profile, "certificate", "00000000-0000-4000-8000-000000000081"))
  const rawProfile = await readLocal(profileKey)
  const rawRoot = await readLocal(rootsKey)
  const cas = vi.spyOn(localDb, "compareAndSwapLocal").mockRejectedValue(new Error("atomic storage failure"))
  const changed = vi.fn()
  const unsubscribe = subscribeIdentityDevicePreferences(changed)

  try {
    await expect(saveIdentityName("Changed", "active", async () => {})).rejects.toThrow("atomic storage failure")
  } finally { unsubscribe() }

  expect(cas).toHaveBeenCalledOnce()
  expect(cas.mock.calls[0][0].writes.map(write => write.key).sort()).toEqual([profileKey, rootsKey])
  expect(await readLocal(profileKey)).toBe(rawProfile)
  expect(await readLocal(rootsKey)).toBe(rawRoot)
  expect((await bootstrapIdentity()).identity.displayName).toBe("Original")
  expect(changed).not.toHaveBeenCalled()
})

it("Given another root update wins the first CAS, when rename retries, then retain that edit with both name records committed", async () => {
  const profile = await bootstrapIdentity("Original")
  await defaultStorage.savePersonalRoot(createPersonalRoot(profile, "certificate", "00000000-0000-4000-8000-000000000082"))
  const compareAndSwap = localDb.compareAndSwapLocal.bind(localDb)
  const cas = vi.spyOn(localDb, "compareAndSwapLocal").mockImplementation(async (plan, ensureCurrent) => {
    const bundlesName = plan.writes.some(write => write.key === profileKey) && plan.writes.some(write => write.key === rootsKey)
    if (bundlesName && !raced) {
      raced = true
      await defaultStorage.updatePersonalRootForIdentity(profile.identity.personId, root => {
        if (!root) throw new Error("personal root missing")
        root.displayNamePreset = "Concurrent root edit"
        return root
      })
    }
    return compareAndSwap(plan, ensureCurrent)
  })
  let raced = false
  let eventSnapshot: Promise<[string | null, string | null]> | undefined
  const changed = vi.fn(() => { eventSnapshot = Promise.all([readLocal(profileKey), readLocal(rootsKey)]) })
  const unsubscribe = subscribeIdentityDevicePreferences(changed)

  try { await saveIdentityName("Changed", "active", async () => {}) }
  finally { unsubscribe() }

  expect(raced).toBe(true)
  expect(cas.mock.calls.filter(([plan]) => plan.writes.some(write => write.key === profileKey) && plan.writes.some(write => write.key === rootsKey))).toHaveLength(2)
  expect((await bootstrapIdentity()).identity.displayName).toBe("Changed")
  expect(changed).toHaveBeenCalledExactlyOnceWith(profile.identity.personId)
  const [profileAtNotification, rootAtNotification] = await eventSnapshot!
  expect(JSON.parse(profileAtNotification!).identity.displayName).toBe("Changed")
  expect(JSON.parse(rootAtNotification!)["00000000-0000-4000-8000-000000000082"].identity.displayName).toBe("Changed")
  await expect(defaultStorage.loadPersonalRoot("00000000-0000-4000-8000-000000000082")).resolves.toMatchObject({
    identity: { displayName: "Changed" },
    displayNamePreset: "Concurrent root edit",
  })
  const rawRoot = await readLocal(rootsKey)
  expect(rawRoot).not.toContain("privateKey")
  expect(rawRoot).not.toContain("Pkcs8")
})
