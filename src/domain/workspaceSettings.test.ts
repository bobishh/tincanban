import { hasEntityKind, isItem } from "./model"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import { executeCommand } from "./commands"
import { projectWorkspaceSettings, validateWorkspaceSettingsDraft } from "./workspaceSettings"
import type { WorkspaceDocumentV2 } from "./model"
import { createDefaultPriorityPolicy } from "./priority"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("workspace settings transaction", () => {
  let profile: LocalProfile
  let doc: Automerge.Doc<WorkspaceDocumentV2>

  beforeEach(async () => {
    resetIdentityStorageForTest()
    profile = await bootstrapIdentity("Settings Test")
    doc = Automerge.from(createWorkspaceDoc("settings", "Before", profile.identity.personId, "blank"))
  })

  it("applies workspace, board, fields, columns, and document templates in one CRDT change", async () => {
    const settings = projectWorkspaceSettings(doc)
    settings.workspace.title = "After"
    settings.board.entityName = "book"
    settings.board.columns[0].title = "Unread"
    settings.board.fields = [
      { title: "Author", valueType: "text", required: true },
      { title: "Published At", valueType: "datetime", required: false },
    ]
    settings.documentTemplates = [{ title: "Review", markdown: "# {{title}}" }]

    const result = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings, expectedHeads: Automerge.getHeads(doc) }, profile)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Automerge.getChanges(doc, result.value.newDoc)).toHaveLength(1)
    const projected = projectWorkspaceSettings(result.value.newDoc)
    expect(projected.workspace.title).toBe("After")
    expect(projected.board.entityName).toBe("book")
    expect(projected.board.columns[0].title).toBe("Unread")
    expect(projected.board.fields[0].title).toBe("Author")
    expect(projected.board.fields[1].title).toBe("Published At")
    expect(projected.board.fields[1].valueType).toBe("datetime")
    expect(projected.documentTemplates[0]).toMatchObject({ title: "Review", markdown: "# {{title}}" })
  })

  it("Given column colors in JSON, when settings apply, then colors persist and omission restores defaults", async () => {
    const settings = projectWorkspaceSettings(doc)
    settings.board.columns[0].color = "#123abc"
    expect(validateWorkspaceSettingsDraft(settings, doc).valid).toBe(true)
    const result = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings }, profile)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const saved = projectWorkspaceSettings(result.value.newDoc)
    expect(saved.board.columns[0].color).toBe("#123abc")
    saved.board.columns[0].color = "yellow"
    expect(validateWorkspaceSettingsDraft(saved, result.value.newDoc).errors).toContainEqual({ path: "/board/columns/0/color", message: "Color must be a six-digit hex value" })
    delete saved.board.columns[0].color
    const cleared = await executeCommand(result.value.newDoc, { kind: "updateWorkspaceSettings", settings: saved }, profile)
    expect(cleared.ok).toBe(true)
    if (cleared.ok) expect(projectWorkspaceSettings(cleared.value.newDoc).board.columns[0]).not.toHaveProperty("color")
  })

  it("rejects invalid paths and stale heads without changing the document", async () => {
    const settings = projectWorkspaceSettings(doc)
    settings.board.entityName = ""
    expect(validateWorkspaceSettingsDraft(settings, doc).errors[0].path).toBe("/board/entityName")
    const invalid = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings }, profile)
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_input", field: "/board/entityName" } })

    settings.board.entityName = "item"
    const stale = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings, expectedHeads: ["stale"] }, profile)
    expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } })
    expect(doc.title).toBe("Before")
  })

  it("rejects changing an existing field type", async () => {
    const created = await executeCommand(doc, {
      kind: "createField",
      boardId: projectWorkspaceSettings(doc).board.boardId,
      title: "Estimate",
      valueType: "number",
      required: false,
    }, profile)
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const settings = projectWorkspaceSettings(created.value.newDoc)
    settings.board.fields[0].valueType = "text"
    expect(validateWorkspaceSettingsDraft(settings, created.value.newDoc).errors).toContainEqual({
      path: "/board/fields/0/valueType",
      message: "Field type cannot change: Estimate (number [string] → text [string])",
    })
  })

  it("Given a board without an Archive role and archived items, when employee settings are saved, then existing archive semantics are preserved", async () => {
    const initial = projectWorkspaceSettings(doc);
    doc = Automerge.change(doc, mutable => {
      const board = mutable.entities[initial.board.boardId];
      if (!hasEntityKind(board, "board")) throw new Error("Expected board");
      board.archiveColumnId = null;
      mutable.entities["archived-card"] = {
        id: "archived-card", title: "Archived application", body: "", values: {},
        placement: { parentId: initial.board.columns[0].id!, rank: "0/1" },
        createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z",
        lifecycle: JSON.stringify({ state: "archived", changedAt: "2026-10-11T00:00:00.000Z" }),
      };
    });
    const settings = projectWorkspaceSettings(doc);
    settings.board.settings = { stack: "Ruby, Rails", work_profile: "Senior Software Engineer" };
    const result = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings }, profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(projectWorkspaceSettings(result.value.newDoc).board.settings).toEqual(settings.board.settings);
    expect(result.value.newDoc.entities["archived-card"]).toEqual(doc.entities["archived-card"]);
  });

  it("applies the archive role and rejects duplicate archive columns", async () => {
    const settings = projectWorkspaceSettings(doc)
    settings.board.columns[0].title = "Cold storage"
    settings.board.columns[0].archive = true

    const result = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings }, profile)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const projected = projectWorkspaceSettings(result.value.newDoc)
    expect(projected.board.columns[0]).toMatchObject({ title: "Cold storage", archive: true })

    projected.board.columns[1].archive = true
    expect(validateWorkspaceSettingsDraft(projected, result.value.newDoc).errors).toContainEqual({
      path: "/board/columns/1/archive",
      message: "Only one archive column is allowed",
    })
  })

  it("stores board archive reference for a newly added schema column without an ID", async () => {
    const settings = projectWorkspaceSettings(doc)
    settings.board.columns.push({ title: "Archive", archive: true })
    const result = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings }, profile)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const board = result.value.newDoc.entities[settings.board.boardId]
    if (!hasEntityKind(board, "board")) throw new Error("Expected updated board")
    const archive = board.archiveColumnId ? result.value.newDoc.entities[board.archiveColumnId] : undefined
    if (!archive || !hasEntityKind(archive, "column")) throw new Error("Expected designated archive column")
    expect(board.archiveColumnId).toBeTruthy()
    expect(archive.title).toBe("Archive")
    expect(archive).not.toHaveProperty("archive")
    expect(archive.collapsible).toBeUndefined()
  })

  it("stores declarative priority rules in the board CRDT and rejects dangling criteria", async () => {
    doc = Automerge.from(createWorkspaceDoc("jobs", "Jobs", profile.identity.personId, "job-search"))
    const settings = projectWorkspaceSettings(doc)
    const board = doc.entities[settings.board.boardId]
    if (!hasEntityKind(board, "board")) throw new Error("board missing")
    const fields = Object.values(doc.entities).filter(entity => hasEntityKind(entity, "field"))
    settings.board.priorityPolicy = createDefaultPriorityPolicy(board, fields)
    settings.board.priorityPolicy!.rules = [{ id: "source-set", fieldId: board.preset!.bindings["field.sourceText"], operator: "is_set", value: null, weight: 1 }]
    settings.board.settings = { stack: "Rust", work_profile: "Backend IC" }

    const result = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings }, profile)
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(projectWorkspaceSettings(result.value.newDoc).board.priorityPolicy).toMatchObject({
      version: 1,
      evaluator: "weighted-rules-v1",
      sort: "fit_desc",
      rules: [{ id: "source-set", fieldId: board.preset!.bindings["field.sourceText"], operator: "is_set", value: null, weight: 1 }],
    })

    expect(projectWorkspaceSettings(result.value.newDoc).board.settings).toEqual({ stack: "Rust", work_profile: "Backend IC" })
    const reordered = projectWorkspaceSettings(result.value.newDoc)
    reordered.board.priorityPolicy!.sort = "fit_asc"
    const reorderedResult = await executeCommand(result.value.newDoc, { kind: "updateWorkspaceSettings", settings: reordered }, profile)
    expect(reorderedResult.ok).toBe(true)
    if (!reorderedResult.ok) return
    expect(projectWorkspaceSettings(reorderedResult.value.newDoc).board.priorityPolicy?.sort).toBe("fit_asc")

    const invalid = projectWorkspaceSettings(reorderedResult.value.newDoc)
    invalid.board.priorityPolicy!.rules[0]!.fieldId = "missing"
    expect(validateWorkspaceSettingsDraft(invalid, result.value.newDoc).errors).toContainEqual({
      path: "/board/priorityPolicy/rules/0/fieldId",
      message: "Rule field must be active on this board",
    })
  })

  it("preserves an unchanged unsupported priority policy while adding automation settings", async () => {
    doc = Automerge.from(createWorkspaceDoc("jobs-legacy-policy", "Jobs", profile.identity.personId, "job-search"))
    let settings = projectWorkspaceSettings(doc)
    const board = doc.entities[settings.board.boardId]
    if (!hasEntityKind(board, "board")) throw new Error("board missing")
    const fields = Object.values(doc.entities).filter(entity => hasEntityKind(entity, "field"))
    const legacyPolicy = { ...createDefaultPriorityPolicy(board, fields)!, evaluator: "job-fit-v1" }
    const existingAutomation = board.automation
    if (!existingAutomation) throw new Error("job-search fixture needs automation settings")

    const firstColumnId = settings.board.columns[0]?.id
    if (!firstColumnId) throw new Error("job-search fixture needs a column")
    const created = await executeCommand(doc, {
      kind: "createItem", parentId: firstColumnId, title: "Keep this card", body: "Existing card data",
    }, profile)
    if (!created.ok) throw new Error(JSON.stringify(created.error))
    doc = created.value.newDoc
    const itemBefore = Object.values(doc.entities).find(isItem)
    if (!itemBefore) throw new Error("created card missing")

    doc = Automerge.change(doc, mutable => {
      const currentBoard = mutable.entities[settings.board.boardId]
      if (!hasEntityKind(currentBoard, "board")) throw new Error("board missing")
      currentBoard.priorityPolicy = legacyPolicy as typeof currentBoard.priorityPolicy
      delete currentBoard.automation
    })
    const policyBefore = doc.entities[settings.board.boardId]
    if (!hasEntityKind(policyBefore, "board")) throw new Error("board missing")
    const storedPolicy = policyBefore.priorityPolicy

    settings = projectWorkspaceSettings(doc)
    settings.board.automation = existingAutomation
    const settingsJson = JSON.parse(JSON.stringify(settings)) as typeof settings
    expect(validateWorkspaceSettingsDraft(settingsJson, doc).valid).toBe(true)
    const result = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings: settingsJson, expectedHeads: Automerge.getHeads(doc) }, profile)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const savedBoard = result.value.newDoc.entities[settings.board.boardId]
    if (!hasEntityKind(savedBoard, "board")) throw new Error("saved board missing")
    expect(savedBoard.automation).toEqual(existingAutomation)
    expect(savedBoard.priorityPolicy).toEqual(storedPolicy)
    expect(result.value.newDoc.entities[itemBefore.id]).toEqual(itemBefore)

    const editedPolicy = projectWorkspaceSettings(result.value.newDoc)
    editedPolicy.board.priorityPolicy!.evaluator = "job-fit-v2"
    expect(validateWorkspaceSettingsDraft(editedPolicy, result.value.newDoc).errors).toContainEqual(expect.objectContaining({
      path: "/board/priorityPolicy/evaluator",
      message: expect.stringContaining("Unsupported priority evaluator"),
    }))

    const removedReference = projectWorkspaceSettings(result.value.newDoc)
    const priorityFieldId = removedReference.board.priorityPolicy!.priorityFieldId
    removedReference.board.fields = removedReference.board.fields.filter(field => field.id !== priorityFieldId)
    expect(validateWorkspaceSettingsDraft(removedReference, result.value.newDoc).errors).toContainEqual(expect.objectContaining({
      path: "/board/priorityPolicy/priorityFieldId",
      message: expect.stringContaining("remain on this board"),
    }))
  })

  it.each([
    { name: "missing column", buttons: [{ columnId: "missing" }], path: "/board/cardStageButtons/0/columnId", message: "Button target must be an active column on this board" },
    { name: "duplicate target", buttons: [{ columnId: "FIRST" }, { columnId: "FIRST" }], path: "/board/cardStageButtons/1/columnId", message: "Button target is duplicated" },
    { name: "blank label", buttons: [{ columnId: "FIRST", label: " " }], path: "/board/cardStageButtons/0/label", message: "Button label must contain text" },
    { name: "unknown key", buttons: [{ columnId: "FIRST", unexpected: true }], path: "/board/cardStageButtons/0/unexpected", message: "Unknown button setting" },
  ])("Given stage buttons with $name, when applying settings, then precise error is returned and source remains unchanged", async ({ buttons, path, message }) => {
    const before = Automerge.getHeads(doc)
    const settings = projectWorkspaceSettings(doc)
    settings.board.cardStageButtons = buttons.map(button => ({ ...button, columnId: button.columnId === "FIRST" ? settings.board.columns[0].id! : button.columnId }))
    expect(validateWorkspaceSettingsDraft(settings, doc)).toMatchObject({ valid: false, errors: expect.arrayContaining([{ path, message }]) })
    const result = await executeCommand(doc, { kind: "updateWorkspaceSettings", settings, expectedHeads: before }, profile)
    expect(result.ok).toBe(false)
    expect(Automerge.getHeads(doc)).toEqual(before)
    expect(projectWorkspaceSettings(doc).board.cardStageButtons).not.toEqual(settings.board.cardStageButtons)
  })

})
