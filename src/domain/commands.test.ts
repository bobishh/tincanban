import { hasEntityKind } from "./model"
import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import {
  createCommandQueue,
  executeCommand,
  executeOwnedCommand,
  executeReviewedWorkspaceChange,
  type Command,
} from "./commands"
import { isItem, type WorkspaceDocumentV2, type Item } from "./model"

vi.mock("@automerge/automerge/slim", async () => {
  const actual = await vi.importActual<typeof Automerge>("@automerge/automerge/slim")
  return { ...actual, view: vi.fn(actual.view) }
})

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Transaction wrapper, commands, and publication queue (Requirement 1.6)", () => {
  let profile: LocalProfile
  let initialDoc: Automerge.Doc<WorkspaceDocumentV2>

  beforeEach(async () => {
    resetIdentityStorageForTest()
    profile = await bootstrapIdentity("Alice Developer")
    const rawWs = createWorkspaceDoc("ws_test", "Test Board", profile.identity.personId, "job-search")
    initialDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
  })

  it("Given a privately owned document, When authoring a command, Then its existing handle carries the signed change and no longer accepts the old view", async () => {
    const heads = Automerge.getHeads(initialDoc)
    const result = await executeOwnedCommand(initialDoc, { kind: "renameWorkspace", title: "Private worker copy" }, profile)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.newDoc.title).toBe("Private worker copy")
    expect(result.value.receipt.beforeHeads).toEqual(heads)
    expect(result.value.proof).toBeTruthy()
    expect(() => Automerge.change(initialDoc, draft => { draft.title = "Stale view" })).toThrow()
    Automerge.free(result.value.newDoc)
  })

  it("executes createItem and patchItem, produces native metadata, and signs a change proof", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const leadCol = Object.values(initialDoc.entities).find((e) => hasEntityKind(e, "column") && e.title === "Lead")!

    const companyField = Object.values(initialDoc.entities).find((e) => hasEntityKind(e, "field") && e.title === "Company")!
    const roleField = Object.values(initialDoc.entities).find((e) => hasEntityKind(e, "field") && e.title === "Role")!

    const createCmd: Command = {
      kind: "createItem",
      parentId: leadCol.id,
      title: "First Item",
      body: "Initial item description",
      values: {
        [companyField.id]: "Acme",
        [roleField.id]: "Engineer",
      },
    }

    const res1 = await queue.transact(createCmd)
    expect(res1.ok).toBe(true)
    if (!res1.ok) return

    const receipt = res1.value.receipt
    expect(receipt.transactionId).toBeTruthy()
    expect(receipt.changeHash).toBeTruthy()
    expect(receipt.changedEntityIds).toHaveLength(1)

    const createdItemId = receipt.changedEntityIds[0]
    const updatedDoc = queue.getDocument()
    const item = updatedDoc.entities[createdItemId] as Item
    expect(item).toBeDefined()
    expect(item.title).toBe("First Item")
    expect(item.body).toBe("Initial item description")
    expect(item.placement.parentId).toBe(leadCol.id)

    // Verify proof
    const proof = res1.value.proof
    expect(proof.payload.kind).toBe("change-proof")
    expect(proof.payload.changeHash).toBe(receipt.changeHash)

    // Now patch title
    const patchCmd: Command = {
      kind: "patchItem",
      entityId: createdItemId,
      title: "Patched Title",
    }
    const res2 = await queue.transact(patchCmd)
    expect(res2.ok).toBe(true)

    const patchedItem = queue.getDocument().entities[createdItemId] as Item
    expect(patchedItem.title).toBe("Patched Title")
    expect(patchedItem.body).toBe("Initial item description") // body preserved
    expect(patchedItem.lastActivityAt).toBeTruthy()
  })

  it("binds editor grant provenance into the signed Automerge message", async () => {
    const column = Object.values(initialDoc.entities).find((entity) => hasEntityKind(entity, "column") && entity.title === "Lead")!
    const result = await executeCommand(initialDoc, { kind: "createItem", parentId: column.id, title: "Bound grant" }, profile,
      undefined, "grant-envelope-hash")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const change = Automerge.decodeChange(Automerge.getLastLocalChange(result.value.newDoc)!)
    const metadata = JSON.parse(change.message!) as Record<string, unknown>
    expect(metadata).toMatchObject({ kind: "workspace-change-metadata", version: 1,
      personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityGrantHash: "grant-envelope-hash" })
  })

  it("rebases reviewed field deltas onto latest authorized fields and records the source hash", async () => {
    const column = Object.values(initialDoc.entities).find(entity => hasEntityKind(entity, "column") && entity.title === "Lead")!
    const created = await executeCommand(initialDoc, { kind: "createItem", parentId: column.id, title: "Original" }, profile)
    if (!created.ok) throw new Error(created.error.message)
    const itemId = created.value.receipt.changedEntityIds[0]!
    const latest = Automerge.change(created.value.newDoc, draft => {
      ;(draft.entities[itemId] as Item).body = "Concurrent authorized body"
    })
    const reviewed = await executeReviewedWorkspaceChange(latest, "quarantined-source-hash",
      { root: {}, entities: [{ id: itemId, changes: { title: "Reviewed title" }, removedKeys: [] }] }, profile, "grant-envelope-hash")
    if (!reviewed.ok) throw new Error(reviewed.error.message)
    const resultItem = reviewed.value.newDoc.entities[itemId] as Item
    expect(resultItem.title).toBe("Reviewed title")
    expect(resultItem.body).toBe("Concurrent authorized body")
    const metadata = JSON.parse(Automerge.decodeChange(Automerge.getLastLocalChange(reviewed.value.newDoc)!).message!)
    expect(metadata).toMatchObject({ sourceChangeHash: "quarantined-source-hash", authorityGrantHash: "grant-envelope-hash" })
  })

  it("records column-status changes as activity, but does not reset activity when reordering", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
    const blankDoc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("aging", "Aging", profile.identity.personId, "blank"))
    const queue = createCommandQueue(blankDoc, profile)
    const columns = Object.values(blankDoc.entities).filter(entity => hasEntityKind(entity, "column"))
    const created = await queue.transact({ kind: "createItem", parentId: columns[0].id, title: "First" })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const itemId = created.value.receipt.changedEntityIds[0]
    const initialActivity = (queue.getDocument().entities[itemId] as Item).lastActivityAt

    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"))
    await queue.transact({ kind: "moveEntity", entityId: itemId, parentId: columns[0].id, beforeId: null })
    expect((queue.getDocument().entities[itemId] as Item).lastActivityAt).toBe(initialActivity)

    await queue.transact({ kind: "moveEntity", entityId: itemId, parentId: columns[1].id, beforeId: null })
    expect((queue.getDocument().entities[itemId] as Item).lastActivityAt).toBe("2026-01-02T00:00:00.000Z")

    vi.useRealTimers()
  })

  it("preserves independent offline title and value edits when merged", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const leadCol = Object.values(initialDoc.entities).find((e) => hasEntityKind(e, "column") && e.title === "Lead")!
    const companyField = Object.values(initialDoc.entities).find((e) => hasEntityKind(e, "field") && e.title === "Company")!

    const roleField = Object.values(initialDoc.entities).find((e) => hasEntityKind(e, "field") && e.title === "Role")!

    const createRes = await queue.transact({
      kind: "createItem",
      parentId: leadCol.id,
      title: "Base Item",
      body: "Base Body",
      values: { [companyField.id]: "Initial Company", [roleField.id]: "Developer" },
    })
    expect(createRes.ok).toBe(true)
    if (!createRes.ok) return
    const itemId = createRes.value.receipt.changedEntityIds[0]

    // Fork document into replica A and replica B with valid hex actor IDs
    const actorA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const actorB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    const docA = Automerge.clone(queue.getDocument(), { actor: actorA })
    const docB = Automerge.clone(queue.getDocument(), { actor: actorB })

    const queueA = createCommandQueue(docA, profile, actorA)
    const queueB = createCommandQueue(docB, profile, actorB)

    // Replica A updates title
    await queueA.transact({
      kind: "patchItem",
      entityId: itemId,
      title: "Title by Tab A",
    })

    // Replica B updates company field value
    await queueB.transact({
      kind: "patchItem",
      entityId: itemId,
      values: { [companyField.id]: "Company by Tab B" },
    })

    // Merge A and B
    const merged = Automerge.merge(queueA.getDocument(), queueB.getDocument())
    const mergedItem = merged.entities[itemId] as Item

    // BOTH edits survived because actual properties were patched in place!
    expect(mergedItem.title).toBe("Title by Tab A")
    expect(mergedItem.values[companyField.id]).toBe("Company by Tab B")
    expect(mergedItem.body).toBe("Base Body")
  })

  it("folds preset Notes and inline note documents into Description atomically", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const board = Object.values(initialDoc.entities).find(entity => entity.kind === "board")!
    const todo = Object.values(initialDoc.entities).find(entity => entity.kind === "column" && entity.title === "Lead")!
    const notesField = board.kind === "board" ? board.preset!.bindings["field.notes"] : ""
    const created = await queue.transact({ kind: "createItem", parentId: todo.id, title: "Legacy", body: "Description", values: { [notesField]: "Preset Notes" } })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const itemId = created.value.receipt.changedEntityIds[0]
    const added = await queue.transact({ kind: "addDocument", itemId, documentKind: "note", title: "Interview", format: "html", content: "<b>HTML text</b>" })
    expect(added.ok).toBe(true)
    if (!added.ok) return
    const noteId = added.value.receipt.changedEntityIds[0]
    const note = queue.getDocument().entities[noteId]
    if (note.kind !== "document") return

    const folded = await queue.transact({
      kind: "patchItem", entityId: itemId,
      body: "Description\n\nPreset Notes\n\n## Interview\n\n<b>HTML text</b>",
      values: { [notesField]: "" },
      foldNarrativeSources: { expectedBody: "Description", notesFieldId: notesField, expectedNotes: "Preset Notes", notes: [{ id: note.id, title: note.title, content: note.content, format: note.format }] },
    })
    expect(folded.ok).toBe(true)
    expect((queue.getDocument().entities[itemId] as Item).body).toContain("<b>HTML text</b>")
    expect((queue.getDocument().entities[itemId] as Item).values[notesField]).toBe("")
    expect(queue.getDocument().entities[noteId]?.archivedAt).toBeTruthy()
    expect(folded.ok && folded.value.receipt.changedEntityIds).toEqual(expect.arrayContaining([itemId, noteId]))
  })

  it("rejects stale narrative sources without retiring note content and validates required Notes through Description", async () => {
    const requiredDoc = Automerge.change(initialDoc, draft => {
      const notes = Object.values(draft.entities).find(entity => entity.kind === "field" && entity.title === "Notes")
      if (notes?.kind === "field") notes.required = true
    })
    const queue = createCommandQueue(requiredDoc, profile)
    const lead = Object.values(requiredDoc.entities).find(entity => entity.kind === "column" && entity.title === "Lead")!
    const notesField = Object.values(requiredDoc.entities).find(entity => entity.kind === "field" && entity.title === "Notes")!
    const invalid = await queue.transact({ kind: "createItem", parentId: lead.id, title: "Empty", body: "", values: {} })
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    const created = await queue.transact({ kind: "createItem", parentId: lead.id, title: "Legacy", body: "Description", values: { [notesField.id]: "Preset Notes" } })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const itemId = created.value.receipt.changedEntityIds[0]
    const fileNote = await queue.transact({ kind: "addDocument", itemId, documentKind: "note", title: "File note", format: "file" })
    expect(fileNote.ok).toBe(true)
    if (!fileNote.ok) return
    const fileNoteId = fileNote.value.receipt.changedEntityIds[0]
    const patch = await queue.transact({
      kind: "patchItem", entityId: itemId, body: "Description edited", values: { [notesField.id]: "" },
      foldNarrativeSources: { expectedBody: "Description", notesFieldId: notesField.id, expectedNotes: "Preset Notes", notes: [] },
    })
    expect(patch.ok).toBe(true)
    expect(queue.getDocument().entities[fileNoteId]?.archivedAt).toBeNull()
    const invalidFold = await queue.transact({
      kind: "patchItem", entityId: itemId, body: "Again",
      foldNarrativeSources: { expectedBody: "Description edited", notesFieldId: notesField.id, expectedNotes: "", notes: [] },
    })
    expect(invalidFold).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    const blank = await queue.transact({ kind: "patchItem", entityId: itemId, body: "", values: { [notesField.id]: "" } })
    expect(blank).toMatchObject({ ok: false, error: { code: "invalid_input" } })
  })

  it("restores any recorded item version through a new compensating change", async () => {
    const raw = createWorkspaceDoc("ws_history", "History", profile.identity.personId, "blank")
    const queue = createCommandQueue(Automerge.from<WorkspaceDocumentV2>(raw), profile)
    const todo = Object.values(queue.getDocument().entities).find(entity => hasEntityKind(entity, "column") && entity.title === "To do")!
    const created = await queue.transact({ kind: "createItem", parentId: todo.id, title: "Before", body: "Original" })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const itemId = created.value.receipt.changedEntityIds[0]
    const creationHash = created.value.receipt.changeHash
    const patched = await queue.transact({ kind: "patchItem", entityId: itemId, title: "After", body: "Changed" })
    expect(patched.ok).toBe(true)
    if (!patched.ok) return
    const patchHash = patched.value.receipt.changeHash

    const historicalViews = vi.mocked(Automerge.view)
    historicalViews.mockClear()
    const restored = await queue.transact({ kind: "restoreItemVersion", entityId: itemId, changeHash: creationHash })
    expect(historicalViews.mock.calls.length).toBe(0)
    expect(restored.ok).toBe(true)
    expect((queue.getDocument().entities[itemId] as Item)).toMatchObject({ title: "Before", body: "Original" })
    expect(Automerge.getHistory(queue.getDocument()).at(-1)?.change.message).toContain("restoreItemVersion")

    const redone = await queue.transact({ kind: "restoreItemVersion", entityId: itemId, changeHash: patchHash })
    expect(redone.ok).toBe(true)
    expect((queue.getDocument().entities[itemId] as Item)).toMatchObject({ title: "After", body: "Changed" })
  })

  it("restores selected causal version after concurrent branch merge without snapshotting full history", async () => {
    const raw = createWorkspaceDoc("ws_causal_history", "History", profile.identity.personId, "blank")
    const setup = createCommandQueue(Automerge.from<WorkspaceDocumentV2>(raw), profile)
    const todo = Object.values(setup.getDocument().entities).find(entity => hasEntityKind(entity, "column") && entity.title === "To do")!
    const created = await setup.transact({ kind: "createItem", parentId: todo.id, title: "Base title", body: "Base body" })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const itemId = created.value.receipt.changedEntityIds[0]
    const base = setup.getDocument()
    const selected = Automerge.change(Automerge.clone(base, { actor: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), { message: "Selected version" }, draft => {
      (draft.entities[itemId] as Item).title = "Selected version"
    })
    const selectedHash = Automerge.getHeads(selected)[0]!
    const concurrent = Automerge.change(Automerge.clone(base, { actor: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), { message: "Concurrent version" }, draft => {
      (draft.entities[itemId] as Item).title = "Concurrent version"
    })
    const merged = Automerge.merge(Automerge.clone(selected), concurrent)
    expect(Automerge.view(merged, [selectedHash]).entities[itemId]).toMatchObject({ title: "Selected version" })

    const queue = createCommandQueue(merged, profile)
    const restored = await queue.transact({ kind: "restoreItemVersion", entityId: itemId, changeHash: selectedHash })

    expect(restored.ok).toBe(true)
    expect((queue.getDocument().entities[itemId] as Item).title).toBe("Selected version")
    expect(Automerge.getChangesMetaSince(queue.getDocument(), []).map(change => change.hash)).toContain(selectedHash)
  })

  it("Given a compact active document, when restoring an archived item version, then write a fresh current-author change with source provenance", async () => {
    const raw = createWorkspaceDoc("ws_archived_history", "Archived history", profile.identity.personId, "blank")
    const original = createCommandQueue(Automerge.from<WorkspaceDocumentV2>(raw), profile)
    const column = Object.values(original.getDocument().entities).find(entity => hasEntityKind(entity, "column"))!
    const created = await original.transact({ kind: "createItem", parentId: column.id, title: "Original archived title", body: "Original text" })
    if (!created.ok) throw new Error("Fixture item failed")
    const entityId = created.value.receipt.changedEntityIds[0]!
    const snapshot = JSON.parse(JSON.stringify(original.getDocument().entities[entityId])) as Item
    const changeHash = created.value.receipt.changeHash
    const compact = Automerge.from<WorkspaceDocumentV2>(JSON.parse(JSON.stringify(original.getDocument())))
    const queue = createCommandQueue(compact, profile)
    await queue.transact({ kind: "patchItem", entityId, title: "Current title" })
    expect(Automerge.getChangesMetaSince(queue.getDocument(), []).some(change => change.hash === changeHash)).toBe(false)
    const before = Automerge.getHeads(queue.getDocument())
    const restored = await queue.transact({ kind: "restoreItemVersion", entityId, changeHash,
      archived: { baselineId: "A".repeat(43), historyEpoch: 2, observation: "admitted", item: snapshot } })
    expect(restored.ok).toBe(true)
    expect(queue.getDocument().entities[entityId]).toMatchObject({ title: "Original archived title", body: "Original text" })
    const fresh = Automerge.getChangesMetaSince(queue.getDocument(), before)
    expect(fresh).toHaveLength(1)
    expect(JSON.parse(fresh[0]!.message!)).toMatchObject({ personId: profile.identity.personId,
      action: "restoreItemVersion", restoredFrom: { baselineId: "A".repeat(43), historyEpoch: 2, changeHash, observation: "admitted" } })
    expect(fresh[0]!.hash).not.toBe(changeHash)
    const refused = await queue.transact({ kind: "restoreItemVersion", entityId, changeHash,
      archived: { baselineId: "A".repeat(43), historyEpoch: 2, observation: "admitted", item: { ...snapshot, id: "unrelated" } } })
    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_input" } })
  })

  it("rejects invalid commands and cycle-creating moves without mutating document", async () => {
    // Test on a blank board workspace where items have no required fields
    const rawWs = createWorkspaceDoc("ws_blank_test", "Blank Board", profile.identity.personId, "blank")
    const blankDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const queue = createCommandQueue(blankDoc, profile)
    const todoCol = Object.values(blankDoc.entities).find((e) => hasEntityKind(e, "column") && e.title === "To do")!

    // Create Parent Item
    const resP = await queue.transact({
      kind: "createItem",
      parentId: todoCol.id,
      title: "Parent Item",
    })
    expect(resP.ok).toBe(true)
    const parentId = resP.ok ? resP.value.receipt.changedEntityIds[0] : ""

    // Create Child Item under Parent
    const resC = await queue.transact({
      kind: "createItem",
      parentId,
      title: "Child Item",
    })
    expect(resC.ok).toBe(true)
    const childId = resC.ok ? resC.value.receipt.changedEntityIds[0] : ""

    const headsBefore = Automerge.getHeads(queue.getDocument())

    // Try to move Parent Item under Child Item -> creates cycle
    const cycleMoveRes = await queue.transact({
      kind: "moveEntity",
      entityId: parentId,
      parentId: childId,
      beforeId: null,
    })
    expect(cycleMoveRes.ok).toBe(false)
    if (!cycleMoveRes.ok) {
      expect(cycleMoveRes.error.code).toBe("cycle")
    }

    // Heads must be unchanged
    expect(Automerge.getHeads(queue.getDocument())).toEqual(headsBefore)

    // Empty title rename rejection
    const emptyRenameRes = await queue.transact({
      kind: "renameEntity",
      entityId: parentId,
      title: "   ",
    })
    expect(emptyRenameRes.ok).toBe(false)
    if (!emptyRenameRes.ok) {
      expect(emptyRenameRes.error.code).toBe("invalid_input")
    }
  })

  it("handles overlapping same-tab submissions via the publication queue sequentially", async () => {
    // Blank board
    const rawWs = createWorkspaceDoc("ws_blank_concurrent", "Blank Board", profile.identity.personId, "blank")
    const blankDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const queue = createCommandQueue(blankDoc, profile)
    const todoCol = Object.values(blankDoc.entities).find((e) => hasEntityKind(e, "column") && e.title === "To do")!

    // Launch 3 concurrent transactions
    const [r1, r2, r3] = await Promise.all([
      queue.transact({ kind: "createItem", parentId: todoCol.id, title: "Concurrent 1" }),
      queue.transact({ kind: "createItem", parentId: todoCol.id, title: "Concurrent 2" }),
      queue.transact({ kind: "createItem", parentId: todoCol.id, title: "Concurrent 3" }),
    ])

    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(r3.ok).toBe(true)

    const allItems = Object.values(queue.getDocument().entities).filter(isItem)
    expect(allItems).toHaveLength(3)
    const titles = allItems.map((t) => t.title)
    expect(titles).toContain("Concurrent 1")
    expect(titles).toContain("Concurrent 2")
    expect(titles).toContain("Concurrent 3")
  })

  it("creates and patches field options on select fields", async () => {
    const rawWs = createWorkspaceDoc("ws_options_test", "Select Board", profile.identity.personId, "blank")
    const blankDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const queue = createCommandQueue(blankDoc, profile)
    const board = Object.values(blankDoc.entities).find((e) => hasEntityKind(e, "board"))!

    // 1. Create select field
    const fieldRes = await queue.transact({
      kind: "createField",
      boardId: board.id,
      title: "Severity",
      valueType: "select",
      required: false,
    })
    expect(fieldRes.ok).toBe(true)
    if (!fieldRes.ok) return
    const fieldId = fieldRes.value.receipt.changedEntityIds[0]

    // 2. Create field option "Low"
    const optRes1 = await queue.transact({
      kind: "createFieldOption",
      fieldId,
      title: "Low",
    })
    expect(optRes1.ok).toBe(true)

    // 3. Create field option "High"
    const optRes2 = await queue.transact({
      kind: "createFieldOption",
      fieldId,
      title: "High",
    })
    expect(optRes2.ok).toBe(true)

    let field = queue.getDocument().entities[fieldId]
    if (!hasEntityKind(field, "field") || field.valueType !== "select") throw new Error("Expected select field")
    const opts = Object.values(field.options)
    expect(opts).toHaveLength(2)
    const lowOpt = opts.find((o) => o.title === "Low")
    expect(lowOpt).toBeDefined()
    if (!lowOpt) throw new Error("Expected Low option")

    // 4. Patch option "Low" -> "Minor"
    const patchOptRes = await queue.transact({
      kind: "patchFieldOption",
      fieldId,
      optionId: lowOpt.id,
      title: "Minor",
    })
    expect(patchOptRes.ok).toBe(true)

    field = queue.getDocument().entities[fieldId]
    if (!hasEntityKind(field, "field") || field.valueType !== "select") throw new Error("Expected select field")
    expect(field.options[lowOpt.id].title).toBe("Minor")
  })

  it("validates datetime field values when creating and patching items", async () => {
    const rawWs = createWorkspaceDoc("ws_dt_test", "Datetime Board", profile.identity.personId, "blank")
    const blankDoc = Automerge.from<WorkspaceDocumentV2>(rawWs)
    const queue = createCommandQueue(blankDoc, profile)
    const board = Object.values(blankDoc.entities).find((e) => hasEntityKind(e, "board"))!
    const col = Object.values(blankDoc.entities).find((e) => hasEntityKind(e, "column"))!

    const fieldRes = await queue.transact({
      kind: "createField",
      boardId: board.id,
      title: "Scheduled Time",
      valueType: "datetime",
      required: true,
    })
    expect(fieldRes.ok).toBe(true)
    if (!fieldRes.ok) return
    const fieldId = fieldRes.value.receipt.changedEntityIds[0]

    // Creating with valid datetime succeeds
    const itemRes = await queue.transact({
      kind: "createItem",
      parentId: col.id,
      title: "Maintenance",
      body: "",
      values: { [fieldId]: "2026-09-12T03:00" },
    })
    expect(itemRes.ok).toBe(true)
    if (!itemRes.ok) return
    const itemId = itemRes.value.receipt.changedEntityIds[0]
    const item = queue.getDocument().entities[itemId]
    if (!isItem(item)) throw new Error("Expected item")
    expect(item.values[fieldId]).toBe("2026-09-12T03:00")

    // Patching with invalid datetime fails
    const patchInvalid = await queue.transact({
      kind: "patchItem",
      entityId: itemId,
      values: { [fieldId]: "invalid-datetime" },
    })
    expect(patchInvalid.ok).toBe(false)

    // Patching with valid ISO datetime with seconds and Z succeeds
    const patchValid = await queue.transact({
      kind: "patchItem",
      entityId: itemId,
      values: { [fieldId]: "2026-09-12T03:30:00Z" },
    })
    expect(patchValid.ok).toBe(true)
    const updatedItem = queue.getDocument().entities[itemId]
    if (!isItem(updatedItem)) throw new Error("Expected item")
    expect(updatedItem.values[fieldId]).toBe("2026-09-12T03:30:00Z")
  })

  it("records workspace archive time and clears it on restore", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    expect(queue.getDocument().archivedAt).toBeNull()

    const deleteRes = await queue.transact({
      kind: "setWorkspaceArchived",
      archived: true,
    })
    expect(deleteRes.ok).toBe(true)
    expect(queue.getDocument().archivedAt).toEqual(expect.any(String))

    const restoreRes = await queue.transact({
      kind: "setWorkspaceArchived",
      archived: false,
    })
    expect(restoreRes.ok).toBe(true)
    expect(queue.getDocument().archivedAt).toBeNull()
  })

  it("handles createBoard by adding a new board entity", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const boardRes = await queue.transact({
      kind: "createBoard",
      title: "Secondary Board",
      preset: "blank",
    })
    expect(boardRes.ok).toBe(true)
    if (!boardRes.ok) return
    const boardId = boardRes.value.receipt.changedEntityIds[0]
    const createdBoard = queue.getDocument().entities[boardId]
    if (!hasEntityKind(createdBoard, "board")) throw new Error("Expected board")
    expect(createdBoard.kind).toBe("board")
    expect(createdBoard.title).toBe("Secondary Board")
    expect(createdBoard.archivedAt).toBeNull()
  })

  it("allows one archive column per board through createColumn", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const firstBoard = Object.values(initialDoc.entities).find(entity => hasEntityKind(entity, "board"))!
    const existing = await queue.transact({ kind: "createColumn", boardId: firstBoard.id, title: "Another archive", archive: true })
    expect(existing).toMatchObject({ ok: false, error: { code: "invalid_input", field: "archive" } })

    const board = await queue.transact({ kind: "createBoard", title: "Second", preset: "blank" })
    expect(board.ok).toBe(true)
    if (!board.ok) return
    const boardId = board.value.receipt.changedEntityIds[0]
    const created = await queue.transact({ kind: "createColumn", boardId, title: "Archive", archive: true })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const createdBoard = queue.getDocument().entities[boardId]
    const createdColumn = queue.getDocument().entities[created.value.receipt.changedEntityIds[0] ?? ""]
    if (!hasEntityKind(createdBoard, "board") || !hasEntityKind(createdColumn, "column")) throw new Error("Expected board and column")
    expect(createdBoard.archiveColumnId).toBe(createdColumn.id)
    expect(createdColumn.collapsible).toBeUndefined()
    expect(await queue.transact({ kind: "createColumn", boardId, title: "Duplicate", archive: true }))
      .toMatchObject({ ok: false, error: { code: "invalid_input", field: "archive" } })
  })

  it("keeps Archive as an item state instead of a placement target", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const columns = Object.values(initialDoc.entities).filter(entity => hasEntityKind(entity, "column"))
    const board = Object.values(initialDoc.entities).find(entity => hasEntityKind(entity, "board"))!
    const archive = columns.find(column => column.id === board.archiveColumnId)!
    const normal = columns.find(column => column.id !== board.archiveColumnId)!
    expect(await queue.transact({ kind: "createItem", parentId: archive.id, title: "Direct" }))
      .toMatchObject({ ok: false, error: { code: "invalid_parent" } })
    const created = await queue.transact({ kind: "createItem", parentId: normal.id, title: "Card" })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(await queue.transact({ kind: "moveEntity", entityId: created.value.receipt.changedEntityIds[0], parentId: archive.id }))
      .toMatchObject({ ok: false, error: { code: "invalid_parent" } })
  })

  it("prevents removing the board's designated archive column", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const board = Object.values(initialDoc.entities).find(entity => hasEntityKind(entity, "board"))!
    const archiveColumnId = board.archiveColumnId!
    expect(await queue.transact({ kind: "setEntityArchived", entityId: archiveColumnId, archived: true }))
      .toMatchObject({ ok: false, error: { code: "invalid_input", field: "archiveColumnId" } })
    const currentBoard = queue.getDocument().entities[board.id]
    if (!hasEntityKind(currentBoard, "board")) throw new Error("Expected board")
    expect(currentBoard.archiveColumnId).toBe(archiveColumnId)
  })

  it("keeps item lifecycle and workflow values paired with timestamps", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const board = Object.values(initialDoc.entities).find(entity => hasEntityKind(entity, "board"))!
    const column = Object.values(initialDoc.entities).find(entity => hasEntityKind(entity, "column") && entity.placement.parentId === board.id && entity.id !== board.archiveColumnId)!
    const created = await queue.transact({ kind: "createItem", parentId: column.id, title: "Transition card" })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const itemId = created.value.receipt.changedEntityIds[0]!
    const createdItem = queue.getDocument().entities[itemId]
    if (!isItem(createdItem)) throw new Error("Expected item")
    const createdLifecycle = JSON.parse(createdItem.lifecycle as string)
    const createdWorkflow = JSON.parse(createdItem.workflow as string)
    expect(createdLifecycle).toMatchObject({ state: "active", changedAt: expect.any(String) })
    expect(createdWorkflow).toMatchObject({ columnId: column.id, changedAt: expect.any(String) })
    expect(createdWorkflow.changedAt).toBe(createdLifecycle.changedAt)
    await queue.transact({ kind: "setEntityArchived", entityId: itemId, archived: true })
    const archivedItem = queue.getDocument().entities[itemId]
    if (!isItem(archivedItem)) throw new Error("Expected item")
    expect(JSON.parse(archivedItem.lifecycle as string)).toMatchObject({ state: "archived", changedAt: expect.any(String) })
    expect(archivedItem).not.toHaveProperty("archivedAt")
    expect(archivedItem.workflow).toBe(createdItem.workflow)
    await queue.transact({ kind: "setEntityArchived", entityId: itemId, archived: false })
    const restoredItem = queue.getDocument().entities[itemId]
    if (!isItem(restoredItem)) throw new Error("Expected item")
    expect(JSON.parse(restoredItem.lifecycle as string)).toMatchObject({ state: "active", changedAt: expect.any(String) })
    expect(restoredItem).not.toHaveProperty("archivedAt")
    expect(restoredItem.workflow).toBe(createdItem.workflow)
  })

  it("rejects createWorkspace on existing workspace document", async () => {
    const queue = createCommandQueue(initialDoc, profile)
    const res = await queue.transact({
      kind: "createWorkspace",
      title: "New Workspace",
      preset: "blank",
    })
    expect(res.ok).toBe(false)
  })
})
