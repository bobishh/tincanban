import { describe, expect, it, vi } from "vitest"

const effects = vi.hoisted(() => ({ rename: vi.fn(), updateRoot: vi.fn(), list: vi.fn(), profile: vi.fn() }))
vi.mock("../domain/identity", () => ({ renameIdentity: effects.rename }))
vi.mock("../storage", () => ({ defaultStorage: { updatePersonalRootForIdentity: effects.updateRoot, listWorkspaces: effects.list } }))
vi.mock("../chat/service", () => ({ ensureChatProfile: effects.profile }))
import { saveIdentityName } from "./identityName"

describe("explicit identity display-name publication", () => {
  it("Given an Identity settings rename, publish its normalized name once per known workspace without letting one unavailable workspace stop the rest", async () => {
    const root = { identity: { personId: "person", displayName: "Previous" }, retained: "personal settings" }
    effects.rename.mockResolvedValue({ identity: { personId: "person", displayName: "Updated name" } })
    effects.updateRoot.mockImplementation(async (_person: string, update: (previous: typeof root) => typeof root | null) => update(root))
    effects.list.mockResolvedValue([{ id: "active" }, { id: "other" }, { id: "active" }, { id: "" }])
    effects.profile.mockImplementation(async (id: string) => { if (id === "active") throw Error("Offline grant unavailable") })
    const refresh = vi.fn().mockResolvedValue(undefined)
    await expect(saveIdentityName(" Updated name ", "active", refresh)).resolves.toBeUndefined()
    expect(effects.rename).toHaveBeenCalledWith(" Updated name ")
    expect(root).toEqual({ identity: { personId: "person", displayName: "Updated name" }, retained: "personal settings" })
    expect(refresh).toHaveBeenCalledOnce()
    expect(effects.profile.mock.calls).toEqual([["active", { updateName: true }], ["other", { updateName: true }]])
  })
})
