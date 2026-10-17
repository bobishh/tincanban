import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { beforeAll, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { prepareCommand } from "./commandHandlers"
import type { AutomationDefinition } from "./automationContract"
import { automationEntityId, automationLifecycle } from "./automationLifecycle"
import { createWorkspaceDoc } from "../test/boardFixture"
import { assertWorkspaceTransition } from "./permissions"
import { validateWorkspaceDoc } from "./validation"
import { hasEntityKind, type WorkspaceDocumentV2 } from "./model"
import type { Command } from "./commandTypes"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

function change(doc: Automerge.Doc<WorkspaceDocumentV2>, command: Command, actor = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
  const prepared = prepareCommand(doc, command, "2026-10-09T12:00:00.000Z", Automerge.getHeads(doc), "owner")
  if (!prepared.ok) throw new Error(prepared.error.message)
  return Automerge.change(Automerge.clone(doc, { actor }), draft => prepared.value.apply(draft))
}

function fixture() {
  const doc = Automerge.from(createWorkspaceDoc("automation-test", "Applications", "owner", "job-search"))
  const board = Object.values(doc.entities).find(entity => hasEntityKind(entity, "board"))!
  const definition: AutomationDefinition = {
    kind: "automation-definition", version: 1, id: "intake-1", name: "Job intake", type: "job-intake", typeVersion: 1,
    parameters: { sources: ["website", "email"] }, permissions: ["workspace.read", "board.lead.create", "board.application.advance"],
    scope: { workspaceId: doc.id, boardId: board.id, grantId: "signed-grant-1" },
  }
  const approval = JSON.stringify({ definition: { payload: definition, signerKeyId: "owner-device", signature: "test-definition" },
    grant: { payload: { kind: "workspace-grant", version: 1, grantId: "signed-grant-1", workspaceId: doc.id, personId: "worker",
      role: "automation", accessEpoch: 1, automation: { version: 1, boardId: board.id,
        columns: { lead: "lead", interview: "interview", rejected: "rejected" }, fieldIds: ["company"], expiresAt: 2000000000000 } },
      signerKeyId: "owner-device", signature: "test-grant" } })
  const created = change(doc, { kind: "createAutomation", definition, approval,
    executor: { origin: "https://automation.example.test", personId: "worker" } })
  return { doc, created, id: automationEntityId(definition.id), definition, approval }
}

it("Given an owner workspace, when an automation is added, paused, resumed and deleted, then controls persist in CRDT and deletion cannot resume", () => {
  const { doc, created, id } = fixture()
  expect(automationLifecycle(created.entities[id])).toMatchObject({ state: "active" })
  expect(validateWorkspaceDoc(created).ok).toBe(true)
  expect(() => assertWorkspaceTransition("owner", doc, created, "owner")).not.toThrow()
  const paused = change(created, { kind: "setAutomationState", automationId: id, state: "paused" })
  const resumed = change(paused, { kind: "setAutomationState", automationId: id, state: "active" })
  const removed = change(resumed, { kind: "setAutomationState", automationId: id, state: "deleted" })
  const restored = Automerge.load<WorkspaceDocumentV2>(Automerge.save(removed))
  expect(automationLifecycle(paused.entities[id]).state).toBe("paused")
  expect(automationLifecycle(resumed.entities[id]).state).toBe("active")
  expect(automationLifecycle(restored.entities[id]).state).toBe("deleted")
  expect(() => change(restored, { kind: "setAutomationState", automationId: id, state: "active" })).toThrow(/deleted/i)
})

it("Given concurrent owner devices, when pause races with resume or deletion, then pause wins until explicitly resolved and deletion remains terminal", () => {
  const { created, id } = fixture()
  const paused = change(created, { kind: "setAutomationState", automationId: id, state: "paused" })
  const resumed = change(created, { kind: "setAutomationState", automationId: id, state: "active" }, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
  const merged = Automerge.merge(paused, resumed)
  expect(automationLifecycle(merged.entities[id])).toMatchObject({ state: "paused", heads: expect.any(Array) })
  expect(automationLifecycle(merged.entities[id]).heads).toHaveLength(2)
  const resolved = change(merged, { kind: "setAutomationState", automationId: id, state: "active" })
  expect(automationLifecycle(resolved.entities[id]).state).toBe("active")
  const deleted = change(created, { kind: "setAutomationState", automationId: id, state: "deleted" }, "cccccccccccccccccccccccccccccccc")
  expect(automationLifecycle(Automerge.merge(resolved, deleted).entities[id]).state).toBe("deleted")
})

it("Given an automation control record, when editor, visitor or Worker changes it, then admission rejects that transition", () => {
  const { doc, created, id } = fixture()
  const paused = change(created, { kind: "setAutomationState", automationId: id, state: "paused" })
  for (const role of ["editor", "visitor", "automation"] as const) {
    expect(() => assertWorkspaceTransition(role, doc, created, "other")).toThrow()
    expect(() => assertWorkspaceTransition(role, created, paused, "other")).toThrow()
  }
  const erased = Automerge.change(Automerge.clone(paused), draft => { delete draft.entities[id] })
  expect(() => assertWorkspaceTransition("owner", paused, erased, "owner")).toThrow(/tombstone/i)
})

it("Given an existing instance or unrelated board scope, when creating an automation, then collision and invalid bindings are rejected", () => {
  const { doc, created, definition, approval } = fixture()
  const executor = { origin: "https://automation.example.test", personId: "worker" }
  expect(() => change(created, { kind: "createAutomation", definition, approval, executor })).toThrow(/exists/i)
  expect(() => change(doc, { kind: "createAutomation", definition: { ...definition, scope: { ...definition.scope, workspaceId: "other" } }, approval, executor })).toThrow(/scope/i)
  expect(() => change(doc, { kind: "createAutomation", definition, approval, executor: { ...executor, origin: "https://automation.example.test/private" } })).toThrow(/origin/i)
})
