import { beforeEach, expect, it } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "../domain/identity"
import { createPersonalRoot } from "../domain/personalRoot"
import { saveIdentityPhoto } from "./identityPhoto"

beforeEach(resetIdentityStorageForTest)
const avatar = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA"
it("Given one identity, when its photo changes or is removed, then durable identity metadata carries one newer value for every workspace", async () => {
  const profile = await bootstrapIdentity("Owner")
  let root = createPersonalRoot(profile, "certificate")
  const storage = { updatePersonalRootForIdentity: async (_id: string, update: (value: typeof root) => typeof root | Promise<typeof root>) => { root = await update(root); return root } }
  const saved = await saveIdentityPhoto(profile, avatar, storage)
  expect(root.photo).toEqual(saved)
  const removed = await saveIdentityPhoto(profile, null, storage)
  expect(removed.avatarData).toBeNull()
  expect(root.profileState?.operations).toHaveLength(2)
})
it("Given failed identity persistence or another person's catalog, when saving, then previous photo remains intact", async () => {
  const profile = await bootstrapIdentity("Owner")
  const root = createPersonalRoot(profile, "certificate")
  const storage = { updatePersonalRootForIdentity: async () => { throw new Error("Disk failure") } }
  await expect(saveIdentityPhoto(profile, avatar, storage)).rejects.toThrow("Disk failure")
  expect(root.photo).toBeUndefined()
  await expect(saveIdentityPhoto(profile, avatar, { updatePersonalRootForIdentity: async (_id, update) => update({ ...root,
    identity: { ...root.identity, personId: "somebody-else" } }) })).rejects.toThrow(/identity/i)
})
