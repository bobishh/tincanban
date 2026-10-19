import { hasEntityKind, type ChangeProof, type TransactionReceipt } from "./domain/model"
import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { IDBFactory, IDBKeyRange } from "fake-indexeddb"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "./crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./domain/identity"
import { prepareLocalChangeAuthorizations, recordGenesisAuthority } from "./sync/changeAuthorization"
import { createPersonalRoot } from "./domain/personalRoot"
import { createWorkspaceDoc } from "./test/boardFixture"
import { deleteLocal, readLocal } from "./localDb"
import { executeCommand, type Command } from "./domain/commands"
import { isItem } from "./domain/model"
import {
  WorkspaceStorage,
  WorkspaceRevisionConflict,
  claimWorkspaceTransaction,
  resolveWorkspaceTransactionClaim,
  type WorkspaceTransactionClaim,
  type WorkspaceTransactionContext,
  setStorageFailureHookForTest,
} from "./storage"
import type { WorkspaceDocumentV2 } from "./domain/model"
import { exportWorkspaceBundleV2, readWorkspaceBundleV2 } from "./domain/workspaceBundle"
import * as journal from "./storageJournal"
import type { WorkspaceDeltaFrontier } from "./workspaceDeltaJournal"
import { createAdmissionCheckpoint } from "./sync/workspaceAdmissionCheckpoint"
import { mergeAuthorizationRecords, type WorkspaceChangeAuthorization } from "./sync/workspaceChangeProofStore"

async function persistSnapshotForTest(storage: WorkspaceStorage, workspaceId: string,
  doc: Automerge.Doc<WorkspaceDocumentV2>, bytes = Automerge.save(doc)) {
  return persistWorkspaceForTest(storage, workspaceId, doc, bytes, [])
}

async function persistWorkspaceForTest(storage: WorkspaceStorage, workspaceId: string,
  ...commit: Parameters<WorkspaceTransactionContext["commitWorkspace"]>) {
  return storage.withWorkspaceTransaction(workspaceId, transaction => transaction.commitWorkspace(...commit))
}

async function persistCommandForTest(storage: WorkspaceStorage, workspaceId: string,
  receipt: TransactionReceipt, changeBytes: Uint8Array,
  proof: ChangeProof) {
  await storage.withWorkspaceTransaction(workspaceId, async transaction => {
    const loaded = await transaction.loadWorkspaceDoc()
    if (!loaded) throw new Error("Workspace not found")
    try {
      await transaction.commitWorkspace(loaded.doc, Automerge.save(loaded.doc), [], { receipt, changeBytes, proof })
    } finally { Automerge.free(loaded.doc) }
  })
  return receipt
}

vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  return { ...actual, load: vi.fn(actual.load) }
})

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("personal root map writes", () => {
  beforeEach(async () => {
    resetIdentityStorageForTest()
    await deleteLocal("tincanban.v1.personal_roots")
  })

  it("serializes writes from separate storage instances without dropping another identity root", async () => {
    const firstProfile = await bootstrapIdentity("First identity")
    const firstRoot = createPersonalRoot(firstProfile, "cert-a", "00000000-0000-4000-8000-000000000001")
    resetIdentityStorageForTest()
    const secondProfile = await bootstrapIdentity("Second identity")
    const secondRoot = createPersonalRoot(secondProfile, "cert-b", "00000000-0000-4000-8000-000000000002")
    const firstTab = new WorkspaceStorage()
    const secondTab = new WorkspaceStorage()

    await Promise.all([firstTab.savePersonalRoot(firstRoot), secondTab.savePersonalRoot(secondRoot)])

    await expect(firstTab.loadPersonalRoot("00000000-0000-4000-8000-000000000001")).resolves.toMatchObject({ rootId: "00000000-0000-4000-8000-000000000001" })
    await expect(secondTab.loadPersonalRoot("00000000-0000-4000-8000-000000000002")).resolves.toMatchObject({ rootId: "00000000-0000-4000-8000-000000000002" })
  })

  it("preserves independent field updates made concurrently from separate tabs", async () => {
    const profile = await bootstrapIdentity("Concurrent owner")
    const storageA = new WorkspaceStorage()
    const storageB = new WorkspaceStorage()
    await storageA.savePersonalRoot(createPersonalRoot(profile, "cert", "00000000-0000-4000-8000-000000000003"))

    await Promise.all([
      storageA.updatePersonalRootForIdentity(profile.identity.personId, async root => {
        if (!root) throw new Error("root missing")
        root.displayNamePreset = "Owner label"
        await Promise.resolve()
        return root
      }),
      storageB.updatePersonalRootForIdentity(profile.identity.personId, async root => {
        if (!root) throw new Error("root missing")
        root.pendingKeeperWithdrawals = { pairing: { pairingId: "pairing", operationId: "operation", pairing: {} } }
        await Promise.resolve()
        return root
      }),
    ])

    await expect(storageA.loadPersonalRoot("00000000-0000-4000-8000-000000000003")).resolves.toMatchObject({
      displayNamePreset: "Owner label",
      pendingKeeperWithdrawals: { pairing: { operationId: "operation" } },
    })
  })

  it("keeps deletion visible to stale storage instances and never recreates a missing root", async () => {
    const profile = await bootstrapIdentity("Deleted owner")
    const staleTab = new WorkspaceStorage()
    const currentTab = new WorkspaceStorage()
    await currentTab.savePersonalRoot(createPersonalRoot(profile, "cert", "00000000-0000-4000-8000-000000000004"))
    await staleTab.loadPersonalRoot("00000000-0000-4000-8000-000000000004")

    await currentTab.updatePersonalRootForIdentity(profile.identity.personId, () => null)
    const staleUpdate = await staleTab.updatePersonalRootForIdentity(profile.identity.personId, root => root)

    expect(staleUpdate).toBeNull()
    await expect(staleTab.loadPersonalRoot("00000000-0000-4000-8000-000000000004")).resolves.toBeNull()
  })

  it("does not persist a root when its mutation rejects", async () => {
    const profile = await bootstrapIdentity("Rejected mutation owner")
    const storage = new WorkspaceStorage()
    await storage.savePersonalRoot(createPersonalRoot(profile, "cert", "00000000-0000-4000-8000-000000000005"))
    const before = await readLocal("tincanban.v1.personal_roots")

    await expect(storage.updatePersonalRootForIdentity(profile.identity.personId, root => {
      if (!root) throw new Error("root missing")
      root.displayNamePreset = "Uncommitted"
      throw new Error("mutation rejected")
    })).rejects.toThrow("mutation rejected")

    expect(await readLocal("tincanban.v1.personal_roots")).toBe(before)
  })
})

describe("Workspace catalog across browser tabs", () => {
  const tab = () => new WorkspaceStorage({ changes: new Map(), proofs: new Map(), receipts: new Map(),
    snapshots: new Map(), workspaces: new Map(), personalRoots: new Map() })

  async function saveCatalogWorkspace(storage: WorkspaceStorage, id: string, title: string, archivedAt: string | null = null) {
    const loaded = await storage.loadWorkspaceDoc(id)
    const base = loaded?.doc ?? Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(id, title, "owner", "blank"))
    const doc = Automerge.change(Automerge.clone(base), draft => { draft.title = title; draft.archivedAt = archivedAt })
    try { await persistSnapshotForTest(storage, id, doc) }
    finally { Automerge.free(doc); Automerge.free(base) }
  }

  it("keeps a received workspace when a stale tab saves another workspace", async () => {
    const existingId = crypto.randomUUID()
    const newId = crypto.randomUUID()
    const old = tab()
    await saveCatalogWorkspace(old, existingId, "Existing")
    const receiving = tab()
    await receiving.listWorkspaces()
    await saveCatalogWorkspace(receiving, newId, "Twang issues")
    await saveCatalogWorkspace(old, existingId, "Edited")
    expect((await tab().listWorkspaces()).map(w => w.id)).toEqual(expect.arrayContaining([existingId, newId]))
  })

  it("reads available and archived entries from one catalog snapshot", async () => {
    const id = crypto.randomUUID()
    const storage = tab()
    await saveCatalogWorkspace(storage, id, "Available")
    await saveCatalogWorkspace(storage, `${id}-archived`, "Archived", new Date().toISOString())
    const readRecords = vi.spyOn(storage as never, "workspaceRecords")

    const catalog = await storage.listWorkspaceCatalog()

    expect(readRecords).toHaveBeenCalledOnce()
    expect(catalog.available.map(workspace => workspace.id)).toContain(id)
    expect(catalog.archived.map(workspace => workspace.id)).toContain(`${id}-archived`)
  })

  it("does not resurrect a archived workspace from a stale tab", async () => {
    const id = crypto.randomUUID()
    const stale = tab()
    const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(id, "Gone", "owner", "blank"))
    await persistSnapshotForTest(stale, id, doc)
    const archived = Automerge.change(doc, draft => { draft.archivedAt = new Date().toISOString() })
    expect(doc.archivedAt).toBeNull()
    await persistSnapshotForTest(tab(), id, archived)
    expect((await stale.listWorkspaces()).some(workspace => workspace.id === id)).toBe(false)
    await expect(persistSnapshotForTest(stale, id, doc)).rejects.toThrow(/archived/i)
    const loaded = (await tab().loadWorkspaceDoc(id))!.doc
    const restored = Automerge.change(Automerge.clone(loaded), draft => { draft.archivedAt = null })
    await persistSnapshotForTest(tab(), id, restored)
    expect((await tab().listWorkspaces()).some(workspace => workspace.id === id)).toBe(true)
  })
})

describe("Document & Change-hash persistence (Requirement 1.7)", () => {
  let profile: LocalProfile
  let storage: WorkspaceStorage

  beforeEach(async () => {
    resetIdentityStorageForTest()
    setStorageFailureHookForTest(false)
    profile = await bootstrapIdentity("Storage User")
    storage = new WorkspaceStorage()
  })

  it("Given a workspace transaction claim, When forged, foreign, reused, or closed, Then it cannot authorize a final write", async () => {
    const workspaceId = crypto.randomUUID()
    let closedClaim!: WorkspaceTransactionClaim
    await storage.withWorkspaceTransaction(workspaceId, async transaction => {
      const forged = { ...transaction }
      expect(() => claimWorkspaceTransaction(forged, workspaceId)).toThrow(WorkspaceRevisionConflict)
      expect(() => claimWorkspaceTransaction(transaction, `${workspaceId}-foreign`)).toThrow(WorkspaceRevisionConflict)

      const capturedBasis = { revision: transaction.capturedRevision,
        frontier: transaction.capturedFrontier, baselineId: transaction.capturedBaselineId }
      const claim = claimWorkspaceTransaction(transaction, workspaceId)
      closedClaim = claim
      const resolved = resolveWorkspaceTransactionClaim(claim, workspaceId)
      expect(resolved.basis).toEqual(capturedBasis)
      expect(() => resolved.ensureCurrent()).not.toThrow()
      expect(() => resolveWorkspaceTransactionClaim(claim, `${workspaceId}-foreign`)).toThrow(WorkspaceRevisionConflict)
      expect(() => claimWorkspaceTransaction(transaction, workspaceId)).toThrow(WorkspaceRevisionConflict)
    })
    expect(() => resolveWorkspaceTransactionClaim(closedClaim, workspaceId).ensureCurrent()).toThrow(WorkspaceRevisionConflict)
  })

  it("Given admission at revision R, When authority changes without changing heads, Then a stale snapshot conflicts and authority remains durable", async () => {
    const previousIndexedDb = globalThis.indexedDB
    const previousKeyRange = globalThis.IDBKeyRange
    const previousNavigator = globalThis.navigator
    vi.stubGlobal("IDBKeyRange", IDBKeyRange)
    vi.stubGlobal("navigator", { locks: { request: async (_name: string, operation: () => Promise<unknown>) => operation() } })
    vi.stubGlobal("indexedDB", new IDBFactory())
    try {
      const base = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Authority race", profile.identity.personId, "blank"))
      await recordGenesisAuthority(base, profile)
      await persistSnapshotForTest(storage, base.id, base)
      const genesisHash = Automerge.getChangesMetaSince(base, [])[0]!.hash
      const authorization = await prepareLocalChangeAuthorizations(base, profile, [genesisHash])
      const secondTab = new WorkspaceStorage()
      let entered!: () => void
      let resume!: () => void
      const atBasis = new Promise<void>(resolve => { entered = resolve })
      const continueCommit = new Promise<void>(resolve => { resume = resolve })

      const staleCommit = storage.withWorkspaceTransaction(base.id, async transaction => {
        const loaded = await transaction.loadWorkspaceDoc()
        if (!loaded) throw new Error("Workspace disappeared")
        const staleCandidate = Automerge.change(Automerge.clone(loaded.doc), draft => { draft.title = "Stale candidate" })
        entered()
        await continueCommit
        try {
          return await transaction.commitWorkspace(staleCandidate, Automerge.save(staleCandidate), [])
        } finally {
          Automerge.free(staleCandidate)
          Automerge.free(loaded.doc)
        }
      })
      await atBasis
      const database = await journal.openWorkspaceJournal()
      const authorityWrite = database.transaction(["authorizations", "frontiers", "revisions"], "readwrite")
      const authorityDone = journal.transactionDone(authorityWrite)
      const authorizationStore = authorityWrite.objectStore("authorizations")
      const stored = await journal.requestResult(authorizationStore.get(base.id)) as { records: WorkspaceChangeAuthorization[] } | undefined
      authorizationStore.put({ id: base.id, workspaceId: base.id,
        records: mergeAuthorizationRecords(stored?.records ?? [], authorization) })
      const frontierStore = authorityWrite.objectStore("frontiers")
      const frontier = await journal.requestResult(frontierStore.get(base.id)) as WorkspaceDeltaFrontier | undefined
      if (frontier) frontierStore.put({ ...frontier, invalidated: true })
      journal.advanceWorkspaceRevision(authorityWrite, base.id)
      await authorityDone
      resume()

      await expect(staleCommit).rejects.toBeInstanceOf(WorkspaceRevisionConflict)
      const current = await secondTab.loadWorkspaceDoc(base.id)
      expect(current?.heads).toEqual(Automerge.getHeads(base).sort())
      expect(await secondTab.getProofs(base.id)).toMatchObject({ changeProofs: [] })
      expect(await (await import("./sync/workspaceChangeProofStore")).records(base.id)).toEqual(authorization)
      Automerge.free(current!.doc)
      Automerge.free(base)
    } finally {
      vi.stubGlobal("indexedDB", previousIndexedDb)
      vi.stubGlobal("IDBKeyRange", previousKeyRange)
      vi.stubGlobal("navigator", previousNavigator)
    }
  })

  it("Given a cross-database authority mutation, When its write fails, Then the admission revision was invalidated first", async () => {
    const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Authority ordering", profile.identity.personId, "blank"))
    try {
      await persistSnapshotForTest(storage, doc.id, doc)
      const before = await storage.readWorkspaceRevision(doc.id)
      await expect(storage.withWorkspaceAuthorityMutation(doc.id, async context => {
        await context.write(async () => {
          expect(await storage.readWorkspaceRevision(doc.id)).not.toBe(before)
          throw new Error("authority database write failed")
        })
      })).rejects.toThrow("authority database write failed")
      expect(await storage.readWorkspaceRevision(doc.id)).not.toBe(before)
    } finally { Automerge.free(doc) }
  })

  it("Given a committed snapshot, When another instance reads the catalog, Then metadata comes only from the atomic journal", async () => {
    const doc = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Atomic catalog", profile.identity.personId, "blank"))
    try {
      await expect(persistSnapshotForTest(storage, doc.id, doc)).resolves.toMatchObject({ proofChanged: false })
      expect((await new WorkspaceStorage().listWorkspaces()).find(record => record.id === doc.id)?.title).toBe(doc.title)
    } finally { Automerge.free(doc) }
  })

  it("loads stored documents without creating unsigned CRDT changes", async () => {
    const raw = createWorkspaceDoc(crypto.randomUUID(), "Legacy", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(raw)
    const column = Object.values(doc.entities).find(e => hasEntityKind(e, "column"))!
    const result = await executeCommand(doc, { kind: "createItem", parentId: column.id, title: "Legacy" }, profile)
    if (!result.ok) throw new Error(result.error.message)
    const heads = Automerge.getHeads(doc)
    await persistSnapshotForTest(storage, doc.id, doc)
    expect((await storage.loadWorkspaceDoc(doc.id))!.heads).toEqual(heads)
  })

  it("reuses a matching snapshot without losing a later journal write or consuming the borrowed document", async () => {
    const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Cached", profile.identity.personId, "blank"))
    await persistSnapshotForTest(storage, doc.id, doc)
    const column = Object.values(doc.entities).find(e => hasEntityKind(e, "column"))!
    const result = await executeCommand(Automerge.clone(doc), { kind: "createItem", parentId: column.id, title: "Other tab" }, profile)
    if (!result.ok) throw new Error(result.error.message)
    await persistCommandForTest(storage, doc.id, result.value.receipt, Automerge.getLastLocalChange(result.value.newDoc)!, result.value.proof)
    const loaded = (await storage.loadWorkspaceDoc(doc.id, doc))!.doc
    expect(Object.values(loaded.entities).filter(isItem).map(item => item.title)).toEqual(["Other tab"])
    expect(Automerge.change(doc, draft => { draft.title = "Still writable" }).title).toBe("Still writable")
  })

  it("loads another tab's newer snapshot when cached heads differ", async () => {
    const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Old", profile.identity.personId, "blank"))
    await persistSnapshotForTest(storage, doc.id, doc)
    const newer = Automerge.change(Automerge.clone(doc), draft => { draft.title = "Other tab saved" })
    await persistSnapshotForTest(storage, doc.id, newer)
    expect((await storage.loadWorkspaceDoc(doc.id, doc))!.doc.title).toBe("Other tab saved")
  })

  it("reuses decoded documents across reads, but sees another storage instance's snapshot and journal writes", async () => {
    const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Cached read", profile.identity.personId, "blank"))
    await persistSnapshotForTest(storage, doc.id, doc)
    const first = (await storage.loadWorkspaceDoc(doc.id))!.doc
    const second = (await storage.loadWorkspaceDoc(doc.id))!.doc
    expect(second.title).toBe("Cached read")
    expect(Automerge.change(second, draft => { draft.title = "Private branch" }).title).toBe("Private branch")
    expect(first.title).toBe("Cached read")
    const other = new WorkspaceStorage()
    const newer = Automerge.change(Automerge.clone(doc), draft => { draft.title = "Other tab saved" })
    await persistSnapshotForTest(other, doc.id, newer)
    expect((await storage.loadWorkspaceDoc(doc.id))!.doc.title).toBe("Other tab saved")
    const column = Object.values(newer.entities).find(e => hasEntityKind(e, "column"))!
    const result = await executeCommand(Automerge.clone(newer), { kind: "createItem", parentId: column.id, title: "Journal delta" }, profile)
    if (!result.ok) throw new Error(result.error.message)
    await persistCommandForTest(other, doc.id, result.value.receipt, Automerge.getLastLocalChange(result.value.newDoc)!, result.value.proof)
    const updated = (await storage.loadWorkspaceDoc(doc.id))!.doc
    expect(Object.values(updated.entities).filter(isItem).map(item => item.title)).toEqual(["Journal delta"])
    await persistSnapshotForTest(storage, doc.id, updated)
    expect((await storage.loadWorkspaceDoc(doc.id))!.heads).toEqual(Automerge.getHeads(updated))
  })

  it("selects the current identity root after enrollment instead of the first stored root", async () => {
    await storage.savePersonalRoot(createPersonalRoot(profile, "old-cert", "00000000-0000-4000-8000-000000000001"))
    resetIdentityStorageForTest()
    const enrolled = await bootstrapIdentity("Enrolled identity")
    await storage.savePersonalRoot(createPersonalRoot(enrolled, "new-cert", "00000000-0000-4000-8000-000000000002"))
    expect((await storage.loadPersonalRoot())?.rootId).toBe("00000000-0000-4000-8000-000000000002")
    expect((await storage.loadPersonalRoot("00000000-0000-4000-8000-000000000001"))?.identity.personId).toBe(profile.identity.personId)
  })

  it("atomically commits change bytes, proof, and transaction receipt", async () => {
    const rawWs = createWorkspaceDoc("ws_atomic", "Atomic Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const initialBytes = Automerge.save(doc)

    // Save initial snapshot
    await persistSnapshotForTest(storage, "ws_atomic", doc, initialBytes)

    const col = Object.values(doc.entities).find((e) => hasEntityKind(e, "column") && e.title === "To do")!
    const cmd: Command = { kind: "createItem", parentId: col.id, title: "Persisted Item" }

    const res = await executeCommand(doc, cmd, profile)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const changeBytes = Automerge.getLastLocalChange(res.value.newDoc)!
    await persistCommandForTest(storage, "ws_atomic", res.value.receipt, changeBytes, res.value.proof)

    // Verify receipt was saved
    const storedReceipt = await storage.getReceipt("ws_atomic", res.value.receipt.transactionId)
    expect(storedReceipt).toBeDefined()
    expect(storedReceipt?.transactionId).toBe(res.value.receipt.transactionId)

    // Verify proof was saved
    const storedProof = await storage.getProof("ws_atomic", res.value.receipt.changeHash)
    expect(storedProof).toBeDefined()
    expect(storedProof?.payload.changeHash).toBe(res.value.receipt.changeHash)

    // Verify reload reproduces the item
    const reloaded = await storage.loadWorkspaceDoc("ws_atomic")
    expect(reloaded).toBeDefined()
    const item = Object.values(reloaded!.doc.entities).find(isItem)
    expect(item?.title).toBe("Persisted Item")
  })

  it.each(["quarantined", "pending"] as const)("Given a legacy journal change classified as %s, When reopening its admitted projection, Then raw journal replay cannot expose that change", async type => {
    const base = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Admitted title", profile.identity.personId, "blank"))
    await persistSnapshotForTest(storage, base.id, base)
    const result = await executeCommand(Automerge.clone(base), { kind: "renameWorkspace", title: "Unadmitted title" }, profile)
    if (!result.ok) throw new Error(result.error.message)
    const { receipt, proof, newDoc } = result.value
    await persistCommandForTest(storage, base.id, receipt, Automerge.getLastLocalChange(newDoc)!, proof)
    const decisions = [{ hash: receipt.changeHash, status: { type, reason: "unreviewed authority" } }]
    await persistWorkspaceForTest(storage, base.id, base, Automerge.save(base), [], undefined, { bytes: Automerge.save(newDoc), decisions })
    const reader = new WorkspaceStorage()
    expect((await reader.loadWorkspaceDoc(base.id))!.doc.title).toBe("Admitted title")
    expect(Automerge.load<WorkspaceDocumentV2>((await reader.loadCausalEvidence(base.id))!.bytes).title).toBe("Unadmitted title")
    expect(await reader.listChanges(base.id)).toHaveLength(1)
  })

  it("Given admitted raw evidence followed by an uncheckpointed legacy write, When loading raw history for reclassification, Then the new change survives without inheriting admission", async () => {
    const base = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Old checkpoint", profile.identity.personId, "blank"))
    const decisions = Automerge.getChangesMetaSince(base, []).map(change => ({ hash: change.hash, status: { type: "admitted" as const, role: "owner" as const } }))
    const admissionCheckpoint = await createAdmissionCheckpoint("old-raw-input", Automerge.getHeads(base), decisions)
    await persistWorkspaceForTest(storage, base.id, base, Automerge.save(base), [], undefined, { bytes: Automerge.save(base), decisions, admissionCheckpoint })
    const result = await executeCommand(Automerge.clone(base), { kind: "renameWorkspace", title: "Legacy tail survives" }, profile)
    if (!result.ok) throw new Error(result.error.message)
    await persistCommandForTest(storage, base.id, result.value.receipt, Automerge.getLastLocalChange(result.value.newDoc)!, result.value.proof)
    const evidence = (await new WorkspaceStorage().loadCausalEvidence(base.id))!
    expect(Automerge.load<WorkspaceDocumentV2>(evidence.bytes).title).toBe("Legacy tail survives")
    expect(evidence.decisions).toEqual(decisions)
    expect(evidence.admissionCheckpoint).toBeUndefined()
  })

  it("Given a full local admission covering every legacy journal hash, When reading unchanged evidence repeatedly, Then raw bytes are reused without decoding historical documents", async () => {
    const base = Automerge.from(createWorkspaceDoc(crypto.randomUUID(), "Checked history", profile.identity.personId, "blank"))
    await persistSnapshotForTest(storage, base.id, base)
    const result = await executeCommand(Automerge.clone(base), { kind: "renameWorkspace", title: "Checked command" }, profile)
    if (!result.ok) throw new Error(result.error.message)
    const { receipt, proof, newDoc } = result.value
    await persistCommandForTest(storage, base.id, receipt, Automerge.getLastLocalChange(newDoc)!, proof)
    const decisions = Automerge.getChangesMetaSince(newDoc, []).map(change => ({ hash: change.hash, status: { type: "admitted" as const, role: "owner" as const } }))
    const admissionCheckpoint = await createAdmissionCheckpoint("checked-input", Automerge.getHeads(newDoc), decisions)
    const bytes = Automerge.save(newDoc)
    await persistWorkspaceForTest(storage, base.id, newDoc, bytes, [], undefined, { bytes, decisions, admissionCheckpoint })
    const load = vi.mocked(Automerge.load)
    load.mockClear()
    for (let index = 0; index < 3; index++) expect((await storage.loadCausalEvidence(base.id))!.bytes).toEqual(bytes)
    expect(load).not.toHaveBeenCalled()
  })

  it("Given raw history and classifications, when causal evidence commits, then raw bytes and decisions survive reload as one snapshot", async () => {
    const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("ws_causal_atomic", "Causal evidence", profile.identity.personId, "blank"))
    const raw = Automerge.save(doc)
    await persistSnapshotForTest(storage, doc.id, doc, raw)
    const evidence = { bytes: raw, decisions: [{ hash: "raw-hash", status: { type: "quarantined" as const, reason: "revoked" } }],
      authorizationEvidence: [{ signed: { signature: "verified-proof" } }], dismissedHashes: [], resolvedReviews: [] }

    await persistWorkspaceForTest(storage, doc.id, doc, raw, [], undefined, evidence)
    const reopened = new WorkspaceStorage({ changes: new Map(), proofs: new Map(), receipts: new Map(),
      snapshots: new Map(), workspaces: new Map(), personalRoots: new Map() })
    expect(await reopened.loadCausalEvidence(doc.id)).toEqual(evidence)

    setStorageFailureHookForTest(true)
    try {
      await expect(persistWorkspaceForTest(storage, doc.id, doc, raw, [], undefined, { ...evidence, decisions: [] })).rejects.toThrow(/Storage failure/i)
    } finally { setStorageFailureHookForTest(false) }
    expect(await reopened.loadCausalEvidence(doc.id)).toEqual(evidence)
  })

  it("Given an identical admitted snapshot and evidence, When replayed without a new command, Then storage performs no journal or catalog write", async () => {
    const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc(crypto.randomUUID(), "Unchanged", profile.identity.personId, "blank"))
    const bytes = Automerge.save(doc)
    const evidence = { bytes, decisions: [], authorizationEvidence: [], dismissedHashes: [], resolvedReviews: [] }
    await persistWorkspaceForTest(storage, doc.id, doc, bytes, [], undefined, evidence)
    const write = vi.spyOn(journal, "writeLocalJournal")
    try {
      await expect(persistWorkspaceForTest(storage, doc.id, doc, bytes, [], undefined, evidence)).resolves.toEqual({ proofChanged: false, causalChanged: false })
      expect(write).not.toHaveBeenCalled()
    } finally { write.mockRestore(); Automerge.free(doc) }
  })

  it("handles same-ID retry idempotently returning existing receipt without duplicating change", async () => {
    const rawWs = createWorkspaceDoc("ws_retry", "Retry Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    await persistSnapshotForTest(storage, "ws_retry", doc)

    const col = Object.values(doc.entities).find((e) => hasEntityKind(e, "column") && e.title === "To do")!
    const res = await executeCommand(doc, { kind: "createItem", parentId: col.id, title: "Idempotent Item" }, profile)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const changeBytes = Automerge.getLastLocalChange(res.value.newDoc)!

    // First commit
    const firstReceipt = await persistCommandForTest(storage, "ws_retry", res.value.receipt, changeBytes, res.value.proof)
    expect(firstReceipt.saved).toBe(true)

    // Retry same transaction ID
    const retryReceipt = await persistCommandForTest(storage, "ws_retry", res.value.receipt, changeBytes, res.value.proof)
    expect(retryReceipt.transactionId).toBe(firstReceipt.transactionId)

    // Check that there is only 1 change stored, not 2
    const allChanges = await storage.listChanges("ws_retry")
    expect(allChanges).toHaveLength(1)
  })

  it("aborts commit cleanly when storage failure hook is active", async () => {
    const rawWs = createWorkspaceDoc("ws_fail", "Fail Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    await persistSnapshotForTest(storage, "ws_fail", doc)

    const col = Object.values(doc.entities).find((e) => hasEntityKind(e, "column") && e.title === "To do")!
    const res = await executeCommand(doc, { kind: "createItem", parentId: col.id, title: "Failed Item" }, profile)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const changeBytes = Automerge.getLastLocalChange(res.value.newDoc)!

    // Activate failure hook
    setStorageFailureHookForTest(true)

    await expect(
      persistCommandForTest(storage, "ws_fail", res.value.receipt, changeBytes, res.value.proof)
    ).rejects.toThrow(/Storage failure/i)

    // Verify nothing uncommitted was saved
    setStorageFailureHookForTest(false)
    const storedReceipt = await storage.getReceipt("ws_fail", res.value.receipt.transactionId)
    expect(storedReceipt).toBeNull()

    const reloaded = await storage.loadWorkspaceDoc("ws_fail")
    const item = Object.values(reloaded!.doc.entities).find(isItem)
    expect(item).toBeUndefined()
  })

  it("handles stale-tab concurrent saves without overwriting unseen writes", async () => {
    const rawWs = createWorkspaceDoc("ws_stale", "Stale Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    await persistSnapshotForTest(storage, "ws_stale", doc)

    const todoCol = Object.values(doc.entities).find((e) => hasEntityKind(e, "column") && e.title === "To do")!

    // Tab 1 creates Item 1
    const actor1 = "11111111111111111111111111111111"
    const docTab1 = Automerge.clone(doc, { actor: actor1 })
    const res1 = await executeCommand(docTab1, { kind: "createItem", parentId: todoCol.id, title: "Tab 1 Item" }, profile, actor1)
    expect(res1.ok).toBe(true)
    if (!res1.ok) return
    await persistCommandForTest(storage, "ws_stale", res1.value.receipt, Automerge.getLastLocalChange(res1.value.newDoc)!, res1.value.proof)

    // Tab 2 (has not loaded Tab 1's change yet) creates Item 2 from original doc
    const actor2 = "22222222222222222222222222222222"
    const docTab2 = Automerge.clone(doc, { actor: actor2 })
    const res2 = await executeCommand(docTab2, { kind: "createItem", parentId: todoCol.id, title: "Tab 2 Item" }, profile, actor2)
    expect(res2.ok).toBe(true)
    if (!res2.ok) return
    await persistCommandForTest(storage, "ws_stale", res2.value.receipt, Automerge.getLastLocalChange(res2.value.newDoc)!, res2.value.proof)

    // Reopening workspace must union both Tab 1 and Tab 2 changes!
    const reloaded = await storage.loadWorkspaceDoc("ws_stale")
    expect(reloaded).toBeDefined()
    const items = Object.values(reloaded!.doc.entities).filter(isItem)
    expect(items).toHaveLength(2)
    const titles = items.map((t) => t.title)
    expect(titles).toContain("Tab 1 Item")
    expect(titles).toContain("Tab 2 Item")
  })

  it("rejects stale compaction, then compacts the reloaded basis without losing concurrent writer content", async () => {
    const rawWs = createWorkspaceDoc("ws_compact", "Compact Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    await persistSnapshotForTest(storage, "ws_compact", doc)
    const todoCol = Object.values(doc.entities).find((e) => hasEntityKind(e, "column") && e.title === "To do")!

    // Save Change 1
    const res1 = await executeCommand(doc, { kind: "createItem", parentId: todoCol.id, title: "Item 1" }, profile)
    if (!res1.ok) throw new Error("res1 failed")
    await persistCommandForTest(storage, "ws_compact", res1.value.receipt, Automerge.getLastLocalChange(res1.value.newDoc)!, res1.value.proof)

    // Concurrently, an unseen writer saves Change 2 on original doc
    const unseenActor = "99999999999999999999999999999999"
    const unseenDoc = Automerge.clone(doc, { actor: unseenActor })
    const resUnseen = await executeCommand(unseenDoc, { kind: "createItem", parentId: todoCol.id, title: "Unseen Writer Item" }, profile, unseenActor)
    if (!resUnseen.ok) throw new Error("resUnseen failed")
    await persistCommandForTest(storage, "ws_compact", resUnseen.value.receipt, Automerge.getLastLocalChange(resUnseen.value.newDoc)!, resUnseen.value.proof)

    // Tab 1's stale snapshot cannot replace the basis after the unseen writer commits.
    await expect(storage.compactWorkspace("ws_compact", res1.value.newDoc)).rejects.toBeInstanceOf(WorkspaceRevisionConflict)

    // The rejected compaction leaves the unseen change available for admission.
    const remainingChanges = await storage.listChanges("ws_compact")
    expect(remainingChanges.some((c) => c.changeHash === resUnseen.value.receipt.changeHash)).toBe(true)

    // Reload the current admitted basis before retrying compaction.
    const current = await storage.loadWorkspaceDoc("ws_compact")
    expect(current).toBeDefined()
    await storage.compactWorkspace("ws_compact", current!.doc)
    Automerge.free(current!.doc)

    // Reload still includes both changes after compaction.
    const reloaded = await storage.loadWorkspaceDoc("ws_compact")
    const items = Object.values(reloaded!.doc.entities).filter(isItem)
    expect(items).toHaveLength(2)
    const titles = items.map((t) => t.title)
    expect(titles).toContain("Item 1")
    expect(titles).toContain("Unseen Writer Item")
  })

  it("persists and reloads personal root document", async () => {
    const root = {
      kind: "personal-root" as const,
      formatVersion: 1 as const,
      rootId: "root_1",
      identity: profile.identity,
      devices: {
        [profile.device.deviceId]: {
          deviceId: profile.device.deviceId,
          publicKey: profile.device.publicKey,
          displayName: profile.device.displayName,
          certificateHash: "cert_hash_1",
          addedAt: new Date().toISOString(),
        },
      },
      workspaces: {
        ws_test: {
          workspaceId: "ws_test",
          documentId: "doc_test",
          grantHash: "grant_1",
          forgotten: false,
        },
      },
    }

    await storage.savePersonalRoot(root)
    const loaded = await storage.loadPersonalRoot("root_1")
    expect(loaded).toBeDefined()
    expect(loaded?.rootId).toBe("root_1")
    expect(loaded?.workspaces["ws_test"].documentId).toBe("doc_test")
  })

  it("exports the current bundle without private keys, personal root, or invitation secrets", async () => {
    const rawWs = createWorkspaceDoc("ws_export", "Export Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)

    const col = Object.values(doc.entities).find((e) => hasEntityKind(e, "column") && e.title === "To do")!
    const res = await executeCommand(doc, { kind: "createItem", parentId: col.id, title: "Exported Item" }, profile)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const changeBytes = Automerge.getLastLocalChange(res.value.newDoc)!
    await persistWorkspaceForTest(storage, "ws_export", res.value.newDoc, Automerge.save(res.value.newDoc), [],
      { receipt: res.value.receipt, changeBytes, proof: res.value.proof })

    const proofs = await storage.getProofs("ws_export")
    expect(proofs.changeProofs).toHaveLength(1)

    await storage.savePersonalRoot({
      kind: "personal-root",
      formatVersion: 1,
      rootId: "root_secret",
      identity: profile.identity,
      devices: {},
      workspaces: {},
    })

    const bundleBytes = await exportWorkspaceBundleV2(res.value.newDoc)
    const result = await readWorkspaceBundleV2(bundleBytes)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const unzipped = result.value

    expect(unzipped.manifest.version).toBe(2)
    expect(unzipped.manifest.workspaceId).toBe("ws_export")

    const strRepr = JSON.stringify(unzipped)
    expect(strRepr).not.toContain("privateKey")
    expect(strRepr).not.toContain("privateKeys")
    expect(strRepr).not.toContain("root_secret")
    expect(strRepr).not.toContain("personal-root")
    expect(strRepr).not.toContain("invitationSecret")
  })

  it("persists changes, proofs, receipts, and personal root across fresh storage instances (simulated reload)", async () => {
    const rawWs = createWorkspaceDoc("ws_reload", "Reload Test", profile.identity.personId, "blank")
    const doc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const initialBytes = Automerge.save(doc)

    await persistSnapshotForTest(storage, "ws_reload", doc, initialBytes)

    const col = Object.values(doc.entities).find((e) => hasEntityKind(e, "column") && e.title === "To do")!
    const res = await executeCommand(doc, { kind: "createItem", parentId: col.id, title: "Persisted Item" }, profile)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const changeBytes = Automerge.getLastLocalChange(res.value.newDoc)!
    await persistCommandForTest(storage, "ws_reload", res.value.receipt, changeBytes, res.value.proof)

    await storage.savePersonalRoot({
      kind: "personal-root",
      formatVersion: 1,
      rootId: "root_reload",
      identity: profile.identity,
      devices: {},
      workspaces: {},
    })

    // Simulate page reload: fresh storage with empty in-memory store
    const freshStorage = new WorkspaceStorage({
      changes: new Map(),
      proofs: new Map(),
      receipts: new Map(),
      snapshots: new Map(),
      workspaces: new Map(),
      personalRoots: new Map(),
    })

    // Should be able to load changes, proofs, receipts, and personal root from persistent backing
    const changes = await freshStorage.listChanges("ws_reload")
    expect(changes).toHaveLength(1)

    const proof = await freshStorage.getProof("ws_reload", res.value.receipt.changeHash)
    expect(proof).toBeDefined()
    expect(proof?.payload.changeHash).toBe(res.value.receipt.changeHash)

    const receipt = await freshStorage.getReceipt("ws_reload", res.value.receipt.transactionId)
    expect(receipt).toBeDefined()

    const root = await freshStorage.loadPersonalRoot("root_reload")
    expect(root).toBeDefined()
    expect(root?.rootId).toBe("root_reload")

    const loadedDoc = await freshStorage.loadWorkspaceDoc("ws_reload")
    expect(loadedDoc).toBeDefined()
    const items = Object.values(loadedDoc!.doc.entities).filter(isItem)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe("Persisted Item")
  })
})
