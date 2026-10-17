import { describe, expect, it } from "vitest"
import { hasEntityKind } from "./model"
import { createWorkspaceDoc } from "../test/boardFixture"
import { assertWorkspaceCommand, assertWorkspaceEntityTransitions, assertWorkspaceRootTransition, assertWorkspaceTransition, canWorkspace, type WorkspaceCapability, type WorkspaceRole } from "./permissions"
import type { Command } from "./commandTypes"

const capabilities: WorkspaceCapability[] = [
  "workspace.rename",
  "content.write",
  "chat.write",
  "chat.profile",
  "board.configure",
  "workspace.import",
  "access.manage",
]

describe("workspace policy", () => {
  it.each([
    ["owner", capabilities],
    ["editor", ["workspace.rename", "content.write", "chat.write", "chat.profile"]],
    ["visitor", ["chat.profile"]],
    ["automation", []],
  ] as const)("gives %s the declared capabilities", (role, allowed) => {
    for (const capability of capabilities) {
      expect(canWorkspace(role as WorkspaceRole, capability)).toBe(allowed.includes(capability as never))
    }
  })

  it("Given an automation role, when checking ordinary UI commands, then grants no manual capability", () => {
    const doc = createWorkspaceDoc("ws", "Board", "owner", "blank")
    expect(canWorkspace("automation", "content.write")).toBe(false)
    expect(canWorkspace("automation", "board.configure")).toBe(false)
    expect(() => assertWorkspaceCommand("automation", doc, { kind: "createItem", parentId: "lead", title: "No" }))
      .toThrow("Automation grants cannot perform manual workspace actions")
  })

  it("uses the same policy for document transitions", () => {
    const before = createWorkspaceDoc("ws", "Before", "owner", "blank")
    const board = Object.values(before.entities).find(entity => hasEntityKind(entity, "board"))!
    const column = Object.values(before.entities).find(entity => hasEntityKind(entity, "column"))!
    before.entities.item = {
      id: "item", title: "Item", body: "", placement: { parentId: column.id, rank: "0/1" },
      archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", values: {},
    }

    const renamed = structuredClone(before)
    renamed.title = "After"
    expect(() => assertWorkspaceTransition("editor", before, renamed)).not.toThrow()

    const content = structuredClone(before)
    content.entities.item!.title = "Edited"
    expect(() => assertWorkspaceTransition("editor", before, content)).not.toThrow()

    const structure = structuredClone(before)
    structure.entities[board.id]!.title = "Changed board"
    expect(() => assertWorkspaceTransition("editor", before, structure)).toThrow("Only the owner can edit board structure")
    expect(() => assertWorkspaceTransition("visitor", before, renamed)).toThrow("Only owners and editors can rename this workspace")
  })

  it("checks typed content commands without diffing workspace entities", () => {
    const doc = createWorkspaceDoc("ws", "Board", "owner", "blank")
    const column = Object.values(doc.entities).find(entity => hasEntityKind(entity, "column"))!
    doc.entities.item = {
      id: "item", title: "Item", body: "", placement: { parentId: column.id, rank: "0/1" },
      archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", values: {},
    }
    const contentCommands: Command[] = [
      { kind: "createItem", parentId: column.id, title: "New" },
      { kind: "patchItem", entityId: "item", body: "Updated" },
      { kind: "patchItem", entityId: "item", foldNarrativeSources: { expectedBody: "", notes: [] } },
      { kind: "restoreItemVersion", entityId: "item", changeHash: "history-hash" },
    ]
    for (const command of contentCommands) expect(() => assertWorkspaceCommand("editor", doc, command)).not.toThrow()

    expect(() => assertWorkspaceCommand("editor", doc, { kind: "renameEntity", entityId: "item", title: "Renamed" })).not.toThrow()
    expect(() => assertWorkspaceCommand("editor", doc, { kind: "renameEntity", entityId: column.id, title: "Renamed" }))
      .toThrow("Only the owner can edit board structure")
    expect(() => assertWorkspaceCommand("editor", doc, { kind: "updateWorkspaceSettings", settings: {} as never }))
      .toThrow("Only the owner can edit board structure")
    expect(() => assertWorkspaceCommand("owner", doc, { kind: "updateWorkspaceSettings", settings: {} as never })).not.toThrow()
    expect(() => assertWorkspaceCommand("editor", doc, { kind: "renameWorkspace", title: "Renamed" })).not.toThrow()
    expect(() => assertWorkspaceCommand("editor", doc, { kind: "setWorkspaceArchived", archived: true }))
      .toThrow("Only the owner can edit board structure")
    expect(() => assertWorkspaceCommand("owner", doc, { kind: "setWorkspaceArchived", archived: true })).not.toThrow()
    expect(() => assertWorkspaceCommand("visitor", doc, { kind: "patchItem", entityId: "item", body: "No" }))
      .toThrow("Visitors can only view this workspace")
  })

  it("lets visitor update only their own CRDT avatar profile", () => {
    const before = createWorkspaceDoc("ws", "Board", "owner", "blank")
    const column = Object.values(before.entities).find(entity => hasEntityKind(entity, "column"))!
    before.entities["avatar-test-item"] = {
      id: "avatar-test-item", title: "Card", body: "", values: {}, placement: { parentId: column.id, rank: "0/1" },
      archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }
    const after = structuredClone(before)
    const personId = "visitor-person"
    const data = JSON.stringify({ avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2026-01-01T00:00:00.000Z" })
    after.entities[`member-profile:${personId}`] = {
      id: `member-profile:${personId}`, kind: "member_profile", personId, data, title: "Member profile",
      placement: { parentId: null, rank: "0/1" }, archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }
    expect(() => assertWorkspaceTransition("visitor", before, after, personId)).not.toThrow()
    expect(() => assertWorkspaceTransition("visitor", before, after, "another-person")).toThrow("A participant may change only their own profile")

    const mixed = structuredClone(after)
    mixed.entities["avatar-test-item"]!.title = "Spoofed content edit"
    expect(() => assertWorkspaceTransition("visitor", before, mixed, personId)).toThrow("Visitors can only view this workspace")
  })

  it("keeps touched-profile admission equivalent for actor, type-smuggling, and mixed edits", () => {
    const before = createWorkspaceDoc("ws", "Board", "owner", "blank")
    const personId = "visitor-person"
    const profileId = `member-profile:${personId}`
    const profile = {
      id: profileId, kind: "member_profile" as const, personId,
      data: JSON.stringify({ avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA", changedAt: "2026-01-01T00:00:00.000Z" }),
      title: "Member profile", placement: { parentId: null, rank: "0/1" }, archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }
    const after = structuredClone(before)
    after.entities[profileId] = profile
    const profileOnly = new Set([profileId])
    expect(() => assertWorkspaceTransition("visitor", before, after, personId)).not.toThrow()
    expect(() => assertWorkspaceEntityTransitions("visitor", before.entities, after.entities, profileOnly, personId)).not.toThrow()
    expect(() => assertWorkspaceTransition("visitor", before, after, "another-person")).toThrow("A participant may change only their own profile")
    expect(() => assertWorkspaceEntityTransitions("visitor", before.entities, after.entities, profileOnly, "another-person"))
      .toThrow("A participant may change only their own profile")

    const smuggled = structuredClone(after)
    const column = Object.values(before.entities).find(entity => hasEntityKind(entity, "column"))!
    smuggled.entities[profileId] = {
      id: profileId, title: "Spoofed profile item", body: "", placement: { parentId: column.id, rank: "0/1" },
      archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", values: {},
    }
    expect(() => assertWorkspaceTransition("visitor", before, smuggled, personId)).toThrow("A participant may change only their own profile")
    expect(() => assertWorkspaceEntityTransitions("visitor", before.entities, smuggled.entities, profileOnly, personId))
      .toThrow("A participant may change only their own profile")

    const mixed = structuredClone(after)
    mixed.entities.item = {
      id: "item", title: "Spoofed content edit", body: "", placement: { parentId: column.id, rank: "0/1" },
      archivedAt: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", values: {},
    }
    expect(() => assertWorkspaceTransition("visitor", before, mixed, personId)).toThrow("Visitors can only view this workspace")
    expect(() => assertWorkspaceEntityTransitions("visitor", before.entities, mixed.entities, new Set([profileId, "item"]), personId))
      .toThrow("Visitors can only view this workspace")
  })

  it("checks touched root paths with the same capability rules", () => {
    expect(() => assertWorkspaceRootTransition("editor", new Set(["title"]))).not.toThrow()
    expect(() => assertWorkspaceRootTransition("visitor", new Set(["title"]))).toThrow("Only owners and editors can rename this workspace")
    expect(() => assertWorkspaceRootTransition("editor", new Set(["settings"]))).toThrow("Only the owner can edit board structure")
    expect(() => assertWorkspaceRootTransition("visitor", new Set())).not.toThrow()
  })
})
