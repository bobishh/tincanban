import { readFile } from "node:fs/promises"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { initializeAutomerge } from "./crdt"
import { createWorkspaceDoc } from "./test/boardFixture"
import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceStorage, WorkspaceTransactionContext } from "./storage"
import type { WorkspaceMeta } from "./storageCatalog"
import { stateRuntime } from "./stateContext"
import { createSyncActions } from "./stateSyncActions"
import { bootstrapIdentity, resetIdentityStorageForTest } from "./domain/identity"
import { createPersonalRoot } from "./domain/personalRoot"
import { clearMeshTrace, meshTraceSnapshot } from "./sync/meshTrace"

beforeAll(async () => {
  await Automerge.initializeWasm(new Uint8Array(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")))
})

const originalDoc = stateRuntime.activeDoc
const originalProfile = stateRuntime.currentProfile

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

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

describe("withWorkspaceDoc", () => {
  it("Given a saved background board, when an async scoped read finishes, then keep its native document alive through the callback and release it afterward", async () => {
    stateRuntime.activeDoc = null
    const doc = Automerge.from(createWorkspaceDoc("scoped-background", "Stored", "owner", "blank"))
    const storage = { loadWorkspaceDoc: async () => ({ doc }) } as unknown as WorkspaceStorage
    const value = await createSyncActions().withWorkspaceDoc(doc.id, async current => {
      await Promise.resolve()
      expect(Automerge.stats(current)).toBeDefined()
      return current.title
    }, storage)
    expect(value).toBe("Stored")
    expect(() => Automerge.stats(doc)).toThrow()
  })

  it("Given a saved background board, when a scoped reader rejects, then release its native document and preserve the original failure", async () => {
    stateRuntime.activeDoc = null
    const doc = Automerge.from(createWorkspaceDoc("scoped-failure", "Stored", "owner", "blank")), failure = new Error("Reader failed")
    const storage = { loadWorkspaceDoc: async () => ({ doc }) } as unknown as WorkspaceStorage
    await expect(createSyncActions().withWorkspaceDoc(doc.id, async () => { throw failure }, storage)).rejects.toBe(failure)
    expect(() => Automerge.stats(doc)).toThrow()
  })

  it("Given the active board, when scoped reads succeed or fail, then leave its borrowed native document usable", async () => {
    const doc = Automerge.from(createWorkspaceDoc("scoped-active", "Current", "owner", "blank"))
    stateRuntime.activeDoc = doc
    const storage = { loadWorkspaceDoc: async () => { throw new Error("Unexpected storage read") } } as unknown as WorkspaceStorage
    try {
      expect(await createSyncActions().withWorkspaceDoc(doc.id, current => current.title, storage)).toBe("Current")
      await expect(createSyncActions().withWorkspaceDoc(doc.id, () => { throw new Error("Reader failed") }, storage)).rejects.toThrow("Reader failed")
      expect(Automerge.stats(doc)).toBeDefined()
    } finally { Automerge.free(doc) }
  })
})

it("Given a retained foreign workspace, when import permission is denied, then release the owned document read for that check without changing the import candidate", async () => {
  const profile = await bootstrapIdentity("Importing visitor")
  stateRuntime.currentProfile = profile
  const candidate = Automerge.from(createWorkspaceDoc("denied-import", "Foreign board", "another-person", "blank"))
  const retained = Automerge.clone(candidate)
  const storage = { loadWorkspaceDoc: async () => ({ doc: retained }) } as unknown as WorkspaceStorage
  try {
    await expect(createSyncActions().importWorkspaceDocument(candidate, storage)).rejects.toThrow("Only the owner can import")
    expect(() => Automerge.stats(retained)).toThrow()
    expect(Automerge.stats(candidate)).toBeDefined()
  } finally {
    try { Automerge.free(retained) } catch { /* It may already have been released by the reader. */ }
    Automerge.free(candidate)
  }
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
