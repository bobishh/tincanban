import { effectScope, nextTick, ref } from "vue"
import { beforeEach, expect, it, vi } from "vitest"
import type { useTincanban } from "../state"
import { useMemberAvatars } from "./useMemberAvatars"

const storage = vi.hoisted(() => ({ loadPersonalRoot: vi.fn() }))
vi.mock("../storage", () => ({ defaultStorage: storage }))
const photo = { avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2026-10-11T17:00:00.000Z" }
beforeEach(() => storage.loadPersonalRoot.mockResolvedValue({ identity: { personId: "owner" }, photo }))

it("Given a saved identity photo while startup checks are pending, when the workspace becomes ready, then publish the photo without another upload", async () => {
  const ready = ref(false)
  const doc = { id: "workspace", entities: {} }
  const execute = vi.fn(async () => {
    if (!ready.value) throw new Error("Saved board is still being checked")
  })
  const workspace = {
    ready, docVersion: ref(1), availableWorkspaces: ref([{ id: doc.id }]),
    getCurrentProfile: () => ({ identity: { personId: "owner" } }),
    getActiveDoc: () => doc, readWorkspaceDoc: async () => doc, executeWorkspaceCommandAsync: execute,
  } as unknown as ReturnType<typeof useTincanban>
  const scope = effectScope()
  const avatars = scope.run(() => useMemberAvatars(workspace))!
  try {
    await vi.waitFor(() => expect(avatars.currentAvatar.value).toBe(photo.avatarData))
    expect(execute).not.toHaveBeenCalled()
    ready.value = true
    await nextTick()
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(doc.id, { kind: "setMemberAvatar", ...photo }))
    expect(avatars.avatarNotice.value).toBe("")
  } finally { scope.stop() }
})
