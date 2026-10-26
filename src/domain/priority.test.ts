import { describe, expect, it } from "vitest"
import { createDefaultPriorityPolicy, evaluatePriority, orderItemsByPriority, projectItemPriority, validatePriorityPolicy } from "./priority"
import type { Board, PriorityPolicy, Item } from "./model"
import { createWorkspaceDoc } from "../test/boardFixture"

const policy: PriorityPolicy = {
  version: 1,
  evaluator: "weighted-rules-v1",
  sort: "fit_desc",
  priorityFieldId: "priority",
  fitFieldId: "fit",
  rules: [
    { id: "remote", fieldId: "mode", operator: "equals", value: "remote", weight: 8 },
    { id: "culture", fieldId: "culture", operator: "equals", value: "healthy", weight: 3 },
    { id: "warning", fieldId: "notes", operator: "contains", value: "hardcore", weight: -4 },
  ],
  bands: [
    { optionId: "p0", minScore: 8 },
    { optionId: "p1", minScore: 6 },
    { optionId: "p2", minScore: 3 },
    { optionId: "p3", minScore: 0 },
  ],
}

it("evaluates weighted rules deterministically and clamps fit to 0–10", () => {
  expect(evaluatePriority(policy, { mode: "remote", culture: "healthy", notes: "normal" })).toEqual({
    score: 10,
    optionId: "p0",
    matchedRuleIds: ["remote", "culture"],
  })
  expect(evaluatePriority(policy, { notes: "Hardcore pace" })).toEqual({
    score: 0,
    optionId: "p3",
    matchedRuleIds: ["warning"],
  })
})

describe("priority projection", () => {
  it("overlays derived outputs without persisting them in source item values", () => {
    const board = { priorityPolicy: policy } as Board
    const item = { values: { mode: "remote", priority: "manual", fit: 1 } } as unknown as Item
    const projected = projectItemPriority(board, item)
    expect(projected.values).toMatchObject({ priority: "p0", fit: 8 })
    expect(item.values).toMatchObject({ priority: "manual", fit: 1 })
  })

  it("returns source item unchanged when automatic priority is disabled", () => {
    const item = { values: { priority: "manual" } } as unknown as Item
    expect(projectItemPriority({ priorityPolicy: null } as Board, item)).toBe(item)
  })

  it("keeps configured preset Notes rules working when text Notes fold into Description", () => {
    const notesPolicy = { ...policy, rules: [{ id: "hardcore", fieldId: "notes", operator: "contains" as const, value: "hardcore", weight: -4 }] }
    const board = { priorityPolicy: notesPolicy, preset: { bindings: { "field.notes": "notes" } } } as unknown as Board
    const legacy = { body: "", values: { mode: "remote", notes: "Hardcore pace" } } as unknown as Item
    const folded = { ...legacy, body: "Hardcore pace", values: { mode: "remote", notes: "" } }
    expect(projectItemPriority(board, legacy, "notes").values.fit).toBe(projectItemPriority(board, folded, "notes").values.fit)
    expect(projectItemPriority(board, { ...folded, body: "Hardcore pace", values: { mode: "remote" } }, "notes").values.fit).toBe(0)
  })
})

describe("priority policy validation", () => {
  it("preserves only an unchanged unsupported policy when the caller opts into existing-policy preservation", () => {
    const doc = createWorkspaceDoc("legacy-priority", "Legacy jobs", "fixture-owner", "job-search")
    const board = Object.values(doc.entities).find((entity): entity is Board => entity.kind === "board")
    if (!board) throw new Error("job-search board fixture missing")
    const fields = Object.values(doc.entities).filter(entity => entity.kind === "field")
    const policy = createDefaultPriorityPolicy(board, fields)
    if (!policy) throw new Error("job-search priority fields missing")
    board.priorityPolicy = { ...policy, evaluator: "job-fit-v1", sort: undefined }
    const projected = { ...board.priorityPolicy, sort: "fit_desc" as const }
    const evaluatorError = { path: "/priorityPolicy/evaluator", message: expect.stringContaining("Unsupported priority evaluator") }

    expect(validatePriorityPolicy(projected, doc, board.id)).toContainEqual(evaluatorError)
    expect(validatePriorityPolicy(projected, doc, board.id, { preserveExistingUnsupported: true })).not.toContainEqual(evaluatorError)
    expect(validatePriorityPolicy(board.priorityPolicy, doc, board.id, { preserveExistingUnsupported: true })).not.toContainEqual(evaluatorError)
    expect(validatePriorityPolicy({ ...projected, evaluator: "job-fit-v2" }, doc, board.id, { preserveExistingUnsupported: true }))
      .toContainEqual(evaluatorError)
  })
})

describe("priority order", () => {
  const remote = { id: "remote", values: { mode: "remote" } } as unknown as Item
  const onsite = { id: "onsite", values: { mode: "onsite" } } as unknown as Item

  it("orders highest fit first by default and keeps equal scores stable", () => {
    const legacyPolicy = { ...policy, sort: undefined }
    expect(orderItemsByPriority({ priorityPolicy: legacyPolicy } as Board, [onsite, remote]).map(item => item.id))
      .toEqual(["remote", "onsite"])
    expect(orderItemsByPriority({ priorityPolicy: policy } as Board, [remote, { ...remote, id: "remote-2" }]).map(item => item.id))
      .toEqual(["remote", "remote-2"])
  })

  it("supports lowest-fit and manual order", () => {
    expect(orderItemsByPriority({ priorityPolicy: { ...policy, sort: "fit_asc" } } as Board, [remote, onsite]).map(item => item.id))
      .toEqual(["onsite", "remote"])
    expect(orderItemsByPriority({ priorityPolicy: { ...policy, sort: "manual" } } as Board, [onsite, remote]))
      .toEqual([onsite, remote])
  })
})
