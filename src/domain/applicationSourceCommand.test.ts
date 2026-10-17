import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, canonicalizeJson, sha256Base64Url, type LocalProfile } from "./identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import { executeCommand, executeReviewedWorkspaceChange, type Command } from "./commands"
import { assertWorkspaceTransition } from "./permissions"
import type { WorkspaceDocumentV2 } from "./model"

const time = "2026-10-14T10:00:00.000Z"
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Signed application-source commands (Requirement 8)", () => {
  let profile: LocalProfile, doc: Automerge.Doc<WorkspaceDocumentV2>
  beforeEach(async () => {
    resetIdentityStorageForTest()
    profile = await bootstrapIdentity("Applicant")
    const raw = createWorkspaceDoc("workspace", "Applications", profile.identity.personId, "blank")
    const board = Object.values(raw.entities).find(entity => entity.kind === "board")!
    raw.entities.column = { id: "column", kind: "column", title: "Applied", placement: { parentId: board.id, rank: "0/1" },
      archivedAt: null, createdAt: time, updatedAt: time }
    raw.entities.card = { id: "card", title: "Incorrect card label", body: "", values: {}, placement: { parentId: "column", rank: "0/1" },
      archivedAt: null, createdAt: time, updatedAt: time }
    doc = Automerge.from(raw)
  })

  async function original(recordId = "original") {
    const text = "Upvest is hiring a Senior Product Engineer (f/m/d)."
    return { kind: "application-source-observation" as const, version: 1 as const, recordId,
      workspaceId: doc.id, cardId: "card", applicationId: "workspace:card",
      observation: { phase: "original" as const, origin: "website" as const, status: "available" as const,
        observedAt: time, jobUrl: "https://example.com/jobs/upvest-123", company: "Upvest",
        title: "Senior Product Engineer (f/m/d)", text, extractorVersion: "fixture-v1",
        contentDigest: await sha256Base64Url(new TextEncoder().encode(text)) } }
  }

  async function capture(recordId?: string) {
    const data = await original(recordId)
    return executeCommand(doc, { kind: "recordApplicationSource", data }, profile)
  }

  it("Given a page-derived original, When recording it, Then one signed independent record is saved without rewriting card labels or workflow", async () => {
    const before = Automerge.toJS(doc), data = await original(), result = await capture()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const next = result.value.newDoc
    expect(next.entities.card).toEqual(before.entities.card)
    expect(result.value.receipt.changedEntityIds).toEqual(["application-source:original"])
    expect(result.value.proof.payload.changeHash).toBe(result.value.receipt.changeHash)
    expect(next.entities["application-source:original"]).toMatchObject({ kind: "application_source", data: canonicalizeJson(data) })
    expect(() => assertWorkspaceTransition("editor", before, Automerge.toJS(next), profile.identity.personId)).not.toThrow()
  })

  it("Given an original with explicit intake references, When recording v2 source data, Then retain references in the immutable signed entity", async () => {
    const data = { ...await original("referenced-original"), version: 2 as const,
      messageIds: ["<submission@example.test>"], atsId: "REQ-42" }
    const result = await executeCommand(doc, { kind: "recordApplicationSource", data }, profile)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const entity = result.value.newDoc.entities[`application-source:${data.recordId}`]
    expect(entity?.kind).toBe("application_source")
    if (entity?.kind !== "application_source") return
    expect(JSON.parse(entity.data)).toEqual(data)
  })

  it("Given a captured original, When retrying its ID or issuing generic edits, Then no replacement or fictitious new receipt is produced", async () => {
    const captured = await capture()
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    doc = captured.value.newDoc
    const heads = Automerge.getHeads(doc)
    const commands: Command[] = [
      { kind: "recordApplicationSource", data: await original() },
      { kind: "renameEntity", entityId: "application-source:original", title: "Replace" },
      { kind: "setEntityArchived", entityId: "application-source:original", archived: true },
      { kind: "moveEntity", entityId: "application-source:original", parentId: "card" },
      { kind: "createItem", id: "application-source:original", parentId: "column", title: "Disguise" },
    ]
    for (const command of commands) {
      const result = await executeCommand(doc, command, profile)
      expect(result.ok).toBe(false)
      expect(Automerge.getHeads(doc)).toEqual(heads)
    }
    const reviewed = await executeReviewedWorkspaceChange(doc, "quarantined-hash", {
      root: {}, entities: [{ id: "application-source:original", changes: { data: "replaced" } }],
    }, profile)
    expect(reviewed.ok).toBe(false)
    expect(Automerge.getHeads(doc)).toEqual(heads)
  })

  it("Given changed text, foreign scope or absent parent, When recording evidence, Then validation fails before a CRDT write", async () => {
    const heads = Automerge.getHeads(doc), data = await original()
    for (const invalid of [{ ...data, observation: { ...data.observation, text: "Substituted text" } },
      { ...data, workspaceId: "foreign", applicationId: "foreign:card" },
      { ...data, cardId: "absent", applicationId: "workspace:absent" }]) {
      const result = await executeCommand(doc, { kind: "recordApplicationSource", data: invalid } as unknown as Command, profile)
      expect(result.ok).toBe(false)
      expect(Automerge.getHeads(doc)).toEqual(heads)
    }
  })

  it("Given independently captured originals, When merging concurrent devices, Then both records survive without a timestamp winner", async () => {
    const a = await capture("device-a"), b = await capture("device-b")
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    const merged = Automerge.merge(a.value.newDoc, b.value.newDoc)
    expect(merged.entities["application-source:device-a"]).toBeTruthy()
    expect(merged.entities["application-source:device-b"]).toBeTruthy()
    expect(merged.entities.card).toEqual(doc.entities.card)
  })

  it("Given several source records under a card, When reordering colliding child ranks, Then only visible children are renumbered", async () => {
    const first = await capture("a"), second = await capture("b")
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    doc = Automerge.merge(first.value.newDoc, second.value.newDoc)
    doc = Automerge.change(doc, draft => {
      for (const id of ["child-a", "child-b", "child-c"]) {
        draft.entities[id] = { id, title: id, body: "", values: {}, placement: { parentId: "card", rank: "0/1" },
          archivedAt: null, createdAt: time, updatedAt: time }
      }
    })
    const before = Automerge.toJS(doc)
    const moved = await executeCommand(doc, { kind: "moveEntity", entityId: "child-c", parentId: "card", beforeId: "child-b" }, profile)
    expect(moved.ok).toBe(true)
    if (!moved.ok) return
    expect(moved.value.newDoc.entities["application-source:a"]).toEqual(before.entities["application-source:a"])
    expect(moved.value.newDoc.entities["application-source:b"]).toEqual(before.entities["application-source:b"])
    expect(() => assertWorkspaceTransition("editor", before, Automerge.toJS(moved.value.newDoc), profile.identity.personId)).not.toThrow()
  })

  it("Given a source draft, When the caller mutates it during asynchronous hashing, Then only the captured and verified evidence can be signed", async () => {
    const data = await original(), originalText = data.observation.text
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const hashing = vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, bytes) => {
      data.observation.text = "Changed after hashing began"
      return digest(algorithm, bytes)
    })
    try {
      const result = await executeCommand(doc, { kind: "recordApplicationSource", data }, profile)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const entity = result.value.newDoc.entities["application-source:original"]
      expect(entity?.kind).toBe("application_source")
      if (entity?.kind !== "application_source") return
      expect((JSON.parse(entity.data) as { observation: { text: string } }).observation.text).toBe(originalText)
    } finally { hashing.mockRestore() }
  })
})
