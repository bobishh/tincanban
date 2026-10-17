import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { prepareCommand } from "./commandHandlers"
import { createWorkspaceDoc } from "../test/boardFixture"
import { hasEntityKind, type WorkspaceDocumentV2 } from "./model"
import { validateWorkspaceDoc } from "./validation"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

function avatarChange(doc: Automerge.Doc<WorkspaceDocumentV2>, actor: string, personId: string, changedAt: string) {
  const prepared = prepareCommand(doc, { kind: "setMemberAvatar", avatarData: "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA" }, changedAt,
    Automerge.getHeads(doc).sort(), personId)
  if (!prepared.ok) throw new Error(prepared.error.message)
  return Automerge.change(Automerge.clone(doc, { actor }), draft => prepared.value.apply(draft))
}

describe("member avatar CRDT concurrency", () => {
  it("merges distinct first profile writes from a legacy document without losing either person", () => {
    const base = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("legacy-workspace", "Board", "owner", "blank"))
    const left = avatarChange(base, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "person-a", "2026-01-01T00:00:00.000Z")
    const right = avatarChange(base, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "person-b", "2026-01-02T00:00:00.000Z")
    const merged = Automerge.merge(left, right)
    expect(hasEntityKind(merged.entities["member-profile:person-a"], "member_profile")).toBe(true)
    expect(hasEntityKind(merged.entities["member-profile:person-b"], "member_profile")).toBe(true)
    expect(validateWorkspaceDoc(merged).ok).toBe(true)
  })
})
