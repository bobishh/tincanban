import * as Automerge from "@automerge/automerge/slim"
import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, type LocalProfile } from "./identity"
import { executeCommand } from "./commands"
import { memberProfileEntityId } from "./avatarData"
import { createWorkspaceDoc } from "../test/boardFixture"
import { hasEntityKind, type WorkspaceDocumentV2 } from "./model"
import { validateWorkspaceDoc } from "./validation"

beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("member avatar profile command", () => {
  let profile: LocalProfile
  let doc: Automerge.Doc<WorkspaceDocumentV2>

  beforeEach(async () => {
    resetIdentityStorageForTest()
    profile = await bootstrapIdentity("Avatar owner")
    doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("avatar-workspace", "Board", profile.identity.personId, "blank"))
  })

  it("writes small avatar data and timestamp as one CRDT profile value", async () => {
    const avatarData = "data:image/webp;base64,UklGRhYAAABXRUJQVlA4WAoAAAAAAAAAfwAAfwAA"
    const result = await executeCommand(doc, { kind: "setMemberAvatar", avatarData }, profile)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const id = memberProfileEntityId(profile.identity.personId)
    const saved = result.value.newDoc.entities[id]
    expect(hasEntityKind(saved, "member_profile")).toBe(true)
    if (!hasEntityKind(saved, "member_profile")) return
    expect(JSON.parse(saved.data)).toEqual({ avatarData, changedAt: expect.any(String) })
    expect(validateWorkspaceDoc(result.value.newDoc).ok).toBe(true)
  })

  it("rejects invalid avatar data and removing a missing photo", async () => {
    const invalid = await executeCommand(doc, { kind: "setMemberAvatar", avatarData: "https://example.test/photo.jpg" }, profile)
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    const missing = await executeCommand(doc, { kind: "setMemberAvatar", avatarData: null }, profile)
    expect(missing).toMatchObject({ ok: false, error: { code: "invalid_input" } })
  })
})

it("Given identity photo removal, when projected to a new workspace, then its timestamped tombstone prevents an old photo from returning", async () => {
  resetIdentityStorageForTest()
  const profile = await bootstrapIdentity("Owner")
  const doc = Automerge.from<WorkspaceDocumentV2>(createWorkspaceDoc("photo-removal", "Board", profile.identity.personId, "blank"))
  const changedAt = "2026-10-09T14:00:00.000Z"
  const result = await executeCommand(doc, { kind: "setMemberAvatar", avatarData: null, changedAt }, profile)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const record = result.value.newDoc.entities[memberProfileEntityId(profile.identity.personId)]
  if (!hasEntityKind(record, "member_profile")) throw new Error("Missing tombstone")
  expect(JSON.parse(record.data)).toEqual({ avatarData: null, changedAt })
  expect(validateWorkspaceDoc(result.value.newDoc).ok).toBe(true)
})
