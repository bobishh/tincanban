import { beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, resetIdentityStorageForTest } from "./domain/identity"
import { createPersonalRoot, pruneForeignGenesisWorkspaceRefs, registerWorkspaceInRoot } from "./domain/personalRoot"
import { resolveSigningContext } from "./domain/signingContext"
import { createIdentityProfileOperation, emptyIdentityProfileState, observeLegacyIdentityProfile } from "./domain/identityProfileState"
import { rootIdentityProfileState } from "./domain/identityProfileRoot"
import type { WorkspaceStorage } from "./storage"
import { initializePersonalRootCatalog } from "./statePersonalRoot"
import { refreshAvailableWorkspaces, resetStateForTest } from "./statePersistence"
import { stateRuntime } from "./stateContext"

vi.mock("./sync/localWorkspaceOwnership", () => {
  throw new Error("Heavy local ownership recovery module loaded without a pending intent")
})

describe("identity-scoped local workspace catalog", () => {
  beforeEach(() => {
    resetIdentityStorageForTest()
    resetStateForTest()
  })

  it("shows root-entitled workspaces, including invited visitor refs, but hides another identity's local docs", async () => {
    const profile = await bootstrapIdentity("New identity")
    const root = createPersonalRoot(profile, "certificate")
    registerWorkspaceInRoot(root, "owned", "owned", "genesis")
    registerWorkspaceInRoot(root, "invited-visitor", "invited-visitor", "import")
    stateRuntime.currentProfile = profile
    const storage = {
      listWorkspaceCatalog: vi.fn().mockResolvedValue({
        available: [
          { id: "owned", title: "Mine", updatedAt: "now" },
          { id: "invited-visitor", title: "Guest board", updatedAt: "now" },
          { id: "old-identity", title: "Untitled", updatedAt: "now" },
        ],
        archived: [{ id: "old-archived", title: "Old", updatedAt: "now" }],
      }),
      loadPersonalRoot: vi.fn().mockResolvedValue(root),
    } as unknown as WorkspaceStorage

    await refreshAvailableWorkspaces(storage)

    expect(stateRuntime.availableWorkspaces.value.map(item => item.id)).toEqual(["owned", "invited-visitor"])
    expect(stateRuntime.archivedWorkspaces.value).toEqual([])
  })

  it("fails closed when legacy root omits its workspace map", async () => {
    const profile = await bootstrapIdentity("New identity")
    const root = { ...createPersonalRoot(profile, "certificate"), workspaces: undefined } as unknown as ReturnType<typeof createPersonalRoot>
    stateRuntime.currentProfile = profile
    stateRuntime.activeWorkspaceMeta.id = "old-local"
    const storage = {
      listWorkspaceCatalog: vi.fn().mockResolvedValue({
        available: [{ id: "old-local", title: "Untitled", updatedAt: "now" }], archived: [],
      }),
      loadPersonalRoot: vi.fn().mockResolvedValue(root),
    } as unknown as WorkspaceStorage

    await expect(refreshAvailableWorkspaces(storage)).resolves.toBeUndefined()
    expect(stateRuntime.availableWorkspaces.value).toEqual([])
  })

  it("repairs polluted genesis refs without dropping invited or unavailable refs", async () => {
    const profile = await bootstrapIdentity("Current identity")
    const root = createPersonalRoot(profile, "certificate")
    registerWorkspaceInRoot(root, "owned", "owned", "genesis")
    registerWorkspaceInRoot(root, "stale-old-owner", "stale-old-owner", "genesis")
    registerWorkspaceInRoot(root, "visitor-invite", "visitor-invite", "import")
    registerWorkspaceInRoot(root, "not-yet-downloaded", "not-yet-downloaded", "genesis")

    expect(pruneForeignGenesisWorkspaceRefs(root, new Map([
      ["owned", profile.identity.personId],
      ["stale-old-owner", "old-identity"],
    ]))).toEqual(["stale-old-owner"])
    expect(Object.keys(root.workspaces).sort()).toEqual(["not-yet-downloaded", "owned", "visitor-invite"])
  })

  it("initializes a normal root without loading the transfer recovery module when no intent exists", async () => {
    const profile = await bootstrapIdentity("Ordinary startup")
    profile.device.deviceId = crypto.randomUUID()
    const root = createPersonalRoot(profile, "certificate")
    const storage = {
      listWorkspaces: vi.fn().mockResolvedValue([]),
      listArchivedWorkspaces: vi.fn().mockResolvedValue([]),
      loadWorkspaceDoc: vi.fn(),
      updatePersonalRootForIdentity: vi.fn(async (_personId: string, update: (current: typeof root | null) => Promise<typeof root | null>) => {
        return await update(root)
      }),
    } as unknown as WorkspaceStorage

    await expect(initializePersonalRootCatalog(storage, profile)).resolves.toBeUndefined()
  })

  it("Given a signed profile history, when initializing an existing root for an adopted device, then preserve its validated name shadow and history", async () => {
    const owner = await bootstrapIdentity("Original name")
    const signing = await resolveSigningContext({ profile: owner, certificates: [owner.certificate], purpose: "identity-profile-update",
      binding: { personId: owner.identity.personId }, authorityRevision: "current", current: async () => ({
        personId: owner.identity.personId, deviceId: owner.device.deviceId, authorityRevision: "current",
      }) })
    let profileState = await observeLegacyIdentityProfile(emptyIdentityProfileState(owner.identity.personId), owner.identity, "name", "Original name")
    const renamed = await createIdentityProfileOperation(signing, profileState, owner.identity, "name", "Signed name")
    profileState = { ...profileState, operations: [renamed] }
    const picture = await createIdentityProfileOperation(signing, profileState, owner.identity, "photo", {
      avatarData: null, changedAt: "2026-10-20T10:00:00.000Z",
    })
    profileState = { ...profileState, operations: [renamed, picture] }
    const root = { ...createPersonalRoot(owner, "certificate"), profileState }
    root.identity.displayName = "Signed name"
    const historyBefore = structuredClone(root.profileState)
    const adopted = { ...owner, identity: { ...owner.identity, displayName: "Portal device label" } }
    let savedRoot = root
    const storage = {
      listWorkspaces: vi.fn().mockResolvedValue([]),
      listArchivedWorkspaces: vi.fn().mockResolvedValue([]),
      loadWorkspaceDoc: vi.fn(),
      updatePersonalRootForIdentity: vi.fn(async (_personId: string, update: (current: typeof root | null) => Promise<typeof root | null>) => {
        savedRoot = (await update(savedRoot))!
        return savedRoot
      }),
    } as unknown as WorkspaceStorage

    await initializePersonalRootCatalog(storage, adopted)

    expect(savedRoot.identity.displayName).toBe("Signed name")
    expect(savedRoot.profileState).toEqual(historyBefore)
  })

  it("Given a conflicting profile history with an unsupported shadow, when initializing, then keep startup available without trusting or rewriting that shadow", async () => {
    const owner = await bootstrapIdentity("Original name")
    let profileState = await observeLegacyIdentityProfile(emptyIdentityProfileState(owner.identity.personId), owner.identity,
      "name", "Original name")
    profileState = await observeLegacyIdentityProfile(profileState, owner.identity, "name", "Other name")
    const root = { ...createPersonalRoot(owner, "certificate"), profileState }
    root.identity.displayName = "Portal device label"
    const historyBefore = structuredClone(root.profileState)
    const adopted = { ...owner, identity: { ...owner.identity, displayName: "Portal device label" } }
    let savedRoot = root
    const storage = {
      listWorkspaces: vi.fn().mockResolvedValue([]),
      listArchivedWorkspaces: vi.fn().mockResolvedValue([]),
      loadWorkspaceDoc: vi.fn(),
      updatePersonalRootForIdentity: vi.fn(async (_personId: string, update: (current: typeof root | null) => Promise<typeof root | null>) => {
        savedRoot = (await update(savedRoot))!
        return savedRoot
      }),
    } as unknown as WorkspaceStorage

    await expect(initializePersonalRootCatalog(storage, adopted)).resolves.toBeUndefined()

    expect(savedRoot.identity.displayName).toBe("Portal device label")
    expect(savedRoot.profileState).toEqual(historyBefore)
    await expect(rootIdentityProfileState(savedRoot)).rejects.toThrow(/presentation.*history/i)
  })
})
