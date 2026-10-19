import { afterEach, describe, expect, it } from "vitest"
import { createWorkspaceDoc } from "./test/boardFixture"
import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceStorage, WorkspaceTransactionContext } from "./storage"
import type { WorkspaceMeta } from "./storageCatalog"
import { stateRuntime } from "./stateContext"
import { createSyncActions } from "./stateSyncActions"
import { bootstrapIdentity, resetIdentityStorageForTest } from "./domain/identity"
import { createPersonalRoot } from "./domain/personalRoot"
import { clearMeshTrace, meshTraceSnapshot } from "./sync/meshTrace"

const originalDoc = stateRuntime.activeDoc
const originalProfile = stateRuntime.currentProfile

afterEach(() => {
  stateRuntime.activeDoc = originalDoc
  stateRuntime.currentProfile = originalProfile
  stateRuntime.availableWorkspaces.value = []
  resetIdentityStorageForTest()
})

describe("readWorkspaceDoc", () => {
  it("returns active authoritative document without touching storage", async () => {
    const doc = createWorkspaceDoc("active-id", "Current", "owner", "blank")
    stateRuntime.activeDoc = doc
    const storage = { loadWorkspaceDoc: async () => { throw new Error("unexpected storage read") } } as unknown as WorkspaceStorage
    expect(await createSyncActions().readWorkspaceDoc(doc.id, storage)).toBe(doc)
  })

  it("loads inactive workspace document without serializing it", async () => {
    const doc = createWorkspaceDoc("inactive-id", "Stored", "owner", "blank")
    stateRuntime.activeDoc = null
    const storage = { loadWorkspaceDoc: async () => ({ doc }) } as unknown as WorkspaceStorage
    expect(await createSyncActions().readWorkspaceDoc(doc.id, storage)).toBe(doc)
  })

  it("distinguishes an absent workspace from a failed storage read without rewriting either cause", async () => {
    stateRuntime.activeDoc = null
    const missing = { loadWorkspaceDoc: async () => null } as unknown as WorkspaceStorage
    await expect(createSyncActions().readWorkspaceDoc("missing", missing)).rejects.toMatchObject({ code: "workspace-unavailable" })
    const failure = new Error("Workspace storage unreadable")
    const broken = { loadWorkspaceDoc: async () => { throw failure } } as unknown as WorkspaceStorage
    await expect(createSyncActions().readWorkspaceDoc("broken", broken)).rejects.toBe(failure)
  })
})

it("Given failing history storage, When access reclassification runs, Then trace preserves the failure stage and cause", async () => {
  clearMeshTrace()
  const storage = {
    withWorkspaceTransaction: async (_id: string, operation: (transaction: Pick<WorkspaceTransactionContext, "loadWorkspaceDoc">) => Promise<unknown>) =>
      operation({ loadWorkspaceDoc: async () => { throw new Error("History read failed") } }),
  } as unknown as WorkspaceStorage
  await expect(createSyncActions().reclassifyWorkspace("trace-workspace", storage)).rejects.toThrow("History read failed")
  expect(meshTraceSnapshot()).toEqual(expect.arrayContaining([expect.objectContaining({
    event: "workspace.reclassify.failed", workspaceId: "trace-workspace", stage: "load-document", reason: "History read failed",
  })]))
})

describe("recordVerifiedOwnerWorkspace", () => {
  it("adds only an owned verified workspace to personal-root catalog", async () => {
    const profile = await bootstrapIdentity("Local owner")
    const root = createPersonalRoot(profile, "certificate")
    const id = "received-owned-board"
    const doc = Automerge.from(createWorkspaceDoc(id, "Future plans", profile.identity.personId, "blank"))
    const catalog: WorkspaceMeta[] = [{ id, title: doc.title, updatedAt: "now" }]
    const storage = {
      loadWorkspaceDoc: async () => ({ doc }),
      loadPersonalRoot: async () => root,
      savePersonalRoot: async () => {},
      updatePersonalRootForIdentity: async (_personId: string, update: (current: typeof root | null) => typeof root | null) => update(root),
      listWorkspaceCatalog: async () => ({ available: catalog, archived: [] }),
    } as unknown as WorkspaceStorage
    stateRuntime.currentProfile = profile

    await createSyncActions().recordVerifiedOwnerWorkspace(id, storage)

    expect(root.workspaces?.[id]).toMatchObject({ workspaceId: id, documentId: id, grantHash: "import" })
    expect(stateRuntime.availableWorkspaces.value.map(workspace => workspace.id)).toEqual([id])
  })

  it("rejects foreign-owned documents without changing personal-root entitlements", async () => {
    const profile = await bootstrapIdentity("Local visitor")
    const root = createPersonalRoot(profile, "certificate")
    const doc = Automerge.from(createWorkspaceDoc("foreign-board", "Foreign", "another-person", "blank"))
    const storage = {
      loadWorkspaceDoc: async () => ({ doc }),
      loadPersonalRoot: async () => root,
      savePersonalRoot: async () => {},
      updatePersonalRootForIdentity: async (_personId: string, update: (current: typeof root | null) => typeof root | null) => update(root),
      listWorkspaceCatalog: async () => ({ available: [{ id: doc.id, title: doc.title, updatedAt: "now" }], archived: [] }),
    } as unknown as WorkspaceStorage
    stateRuntime.currentProfile = profile

    await expect(createSyncActions().recordVerifiedOwnerWorkspace(doc.id, storage))
      .rejects.toThrow("Only a workspace owned by this identity")

    expect(root.workspaces).toEqual({})
    expect(stateRuntime.availableWorkspaces.value).toEqual([])
  })
})
