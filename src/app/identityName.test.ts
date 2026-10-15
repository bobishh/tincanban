import { describe, expect, it, vi } from "vitest"

const effects = vi.hoisted(() => ({
  rename: vi.fn(), bootstrap: vi.fn(), planRoot: vi.fn(), compareAndSwap: vi.fn(), list: vi.fn(), profile: vi.fn(), changed: vi.fn(),
}))
vi.mock("../domain/identity", () => ({ renameIdentity: effects.rename, bootstrapIdentity: effects.bootstrap }))
vi.mock("../domain/identityProfileRoot", () => ({ assertIdentityProfileRevision: async () => {}, editIdentityProfileRoot: async (root: { identity: { displayName: string } }, _profile: unknown, _field: unknown, name: string) => {
  root.identity.displayName = name
  return root
} }))
vi.mock("../storage", () => ({ defaultStorage: { listWorkspaces: effects.list } }))
vi.mock("../storagePersonalRoot", () => ({ planPersonalRootUpdate: effects.planRoot }))
vi.mock("../localDb", () => ({ compareAndSwapLocal: effects.compareAndSwap }))
vi.mock("../sync/identityDevicePreferenceEvents", () => ({ identityDevicePreferencesChanged: effects.changed }))
vi.mock("../chat/service", () => ({ ensureChatProfile: effects.profile }))
import { saveIdentityName } from "./identityName"

describe("explicit identity display-name publication", () => {
  it("Given an Identity settings rename, commit profile and root together, then publish to known workspaces independently", async () => {
    const root = { identity: { personId: "person", displayName: "Previous" }, retained: "personal settings" }
    const profile = { identity: { personId: "person", displayName: "Updated name" } }
    effects.bootstrap.mockResolvedValue(profile)
    effects.planRoot.mockImplementation(async (_person: string, update: (previous: typeof root) => typeof root | null | Promise<typeof root | null>) => {
      const next = await update(root)
      return { conditions: [{ key: "roots", value: "old-roots" }], writes: [{ key: "roots", value: JSON.stringify(next) }] }
    })
    effects.compareAndSwap.mockResolvedValue(true)
    effects.rename.mockImplementation(async (name: string, commit: (plan: unknown, ensureCurrent: () => void) => Promise<void>) => {
      await commit({ storageKey: "profile", previousProfile: "old-profile", candidateProfile: "new-profile",
        publicProfile: { identity: profile.identity } }, () => {})
      return profile
    })
    effects.list.mockResolvedValue([{ id: "active" }, { id: "other" }, { id: "active" }, { id: "" }])
    effects.profile.mockImplementation(async (id: string) => { if (id === "active") throw Error("Offline grant unavailable") })
    const refresh = vi.fn().mockResolvedValue(undefined)

    await expect(saveIdentityName(" Updated name ", "active", refresh)).resolves.toBeUndefined()

    expect(effects.rename).toHaveBeenCalledWith(" Updated name ", expect.any(Function))
    expect(effects.planRoot).toHaveBeenCalledWith("person", expect.any(Function))
    expect(effects.compareAndSwap).toHaveBeenCalledWith({
      conditions: [{ key: "roots", value: "old-roots" }, { key: "profile", value: "old-profile" }],
      writes: [{ key: "roots", value: JSON.stringify({
        identity: { personId: "person", displayName: "Updated name" }, retained: "personal settings",
      }) }, { key: "profile", value: "new-profile" }],
    }, expect.any(Function))
    expect(effects.changed).toHaveBeenCalledWith("person")
    expect(refresh).toHaveBeenCalledOnce()
    expect(effects.profile.mock.calls).toEqual([["active", { updateName: true }], ["other", { updateName: true }]])
  })
})
