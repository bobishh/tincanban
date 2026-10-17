import { readFile } from "node:fs/promises"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import * as Automerge from "@automerge/automerge/slim"
import { initializeAutomerge } from "../crdt"
import { bootstrapIdentity, resetIdentityStorageForTest, sha256Base64Url, type LocalProfile } from "./identity"
import { createWorkspaceDoc } from "../test/boardFixture"
import { executeCommand, type Command } from "./commands"
import type { ApplicationSourceData } from "./applicationSourceData"
import type { WorkspaceDocumentV2 } from "./model"

const time = "2026-10-14T10:00:00.000Z"
type AvailableObservation = Extract<ApplicationSourceData["observation"], { status: "available" }>
beforeAll(async () => {
  const wasm = await readFile("node_modules/@automerge/automerge/dist/automerge.wasm")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(wasm, { headers: { "content-type": "application/wasm" } })))
  await initializeAutomerge()
})

describe("Atomic card and application-source intake command", () => {
  let profile: LocalProfile
  let doc: Automerge.Doc<WorkspaceDocumentV2>

  beforeEach(async () => {
    resetIdentityStorageForTest()
    profile = await bootstrapIdentity("Applicant")
    const raw = createWorkspaceDoc("workspace", "Applications", profile.identity.personId, "blank")
    const board = Object.values(raw.entities).find(entity => entity.kind === "board")!
    raw.entities.column = { id: "column", kind: "column", title: "Applied", placement: { parentId: board.id, rank: "0/1" },
      archivedAt: null, createdAt: time, updatedAt: time }
    doc = Automerge.from(raw)
  })

  async function sourceData(cardId: string, recordId = "original"): Promise<ApplicationSourceData> {
    const text = "Hiring team and role details"
    return { kind: "application-source-observation", version: 1, recordId,
      workspaceId: doc.id, cardId, applicationId: `${doc.id}:${cardId}`,
      observation: { phase: "original", origin: "website", status: "available", observedAt: time,
        jobUrl: "https://jobs.example.test/role", company: "Example", title: "Senior Engineer",
        text, extractorVersion: "fixture-v1", contentDigest: await sha256Base64Url(new TextEncoder().encode(text)) } }
  }

  function command(id: string, data: ApplicationSourceData) {
    return { kind: "createItemWithApplicationSource", id, parentId: "column", title: "My application",
      body: "A note written by the applicant", values: {}, data }
  }

  async function execute(input: unknown) {
    return executeCommand(doc, input as Command, profile)
  }

  it("Given a blank workspace and column, When creating an application, Then one receipt adds a normal card and its independent original source", async () => {
    const id = "application-1"
    const data = await sourceData(id)
    const result = await execute(command(id, data))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Automerge.getChanges(doc, result.value.newDoc)).toHaveLength(1)
    expect(result.value.receipt.changedEntityIds.slice().sort()).toEqual([id, `application-source:${data.recordId}`].sort())
    expect(result.value.proof.payload.changeHash).toBe(result.value.receipt.changeHash)
    expect(result.value.newDoc.entities[id]).toMatchObject({ title: "My application", body: "A note written by the applicant" })
    expect(result.value.newDoc.entities[id]).not.toHaveProperty("kind")
    const source = result.value.newDoc.entities[`application-source:${data.recordId}`]
    expect(source).toMatchObject({ kind: "application_source", title: "Application source", placement: { parentId: id, rank: "0/1" } })
    if (source?.kind !== "application_source") return
    expect(JSON.parse(source.data)).toEqual(data)
    expect(JSON.parse(source.data).observation.title).not.toBe(result.value.newDoc.entities[id]?.title)
  })

  it("Given mismatched scope, digest or occupied IDs, When creating an application, Then no CRDT write occurs", async () => {
    const id = "application-1"
    const valid = await sourceData(id)
    const badDigest = structuredClone(valid)
    ;(badDigest.observation as AvailableObservation).text = "Altered without changing digest"
    const mismatchedCard = { ...valid, cardId: "another-card", applicationId: `${doc.id}:another-card` }
    const foreignWorkspace = { ...valid, workspaceId: "foreign-workspace", applicationId: `foreign-workspace:${id}` }
    const invalidCases: Array<{ input: unknown; description: string }> = [
      { input: command("different-id", valid), description: "command and source card IDs differ" },
      { input: command(id, mismatchedCard), description: "source card ID differs from command ID" },
      { input: command(id, foreignWorkspace), description: "source belongs to another workspace" },
      { input: command(id, badDigest), description: "source digest does not match text" },
    ]
    for (const { input, description } of invalidCases) {
      const heads = Automerge.getHeads(doc)
      const result = await execute(input)
      expect(result.ok, description).toBe(false)
      expect(Automerge.getHeads(doc), description).toEqual(heads)
    }

    doc = Automerge.change(doc, draft => {
      draft.entities[id] = { id, title: "Already here", body: "", values: {},
        placement: { parentId: "column", rank: "0/1" }, archivedAt: null, createdAt: time, updatedAt: time }
    })
    const headsBeforeItemConflict = Automerge.getHeads(doc)
    const itemConflict = await execute(command(id, await sourceData(id, "new-source")))
    expect(itemConflict.ok, "card ID already exists").toBe(false)
    expect(Automerge.getHeads(doc)).toEqual(headsBeforeItemConflict)

    const existingSourceId = "occupied-source"
    const occupiedData = await sourceData(id, existingSourceId)
    const existingSource = { id: `application-source:${existingSourceId}`, kind: "application_source" as const,
      title: "Application source" as const, placement: { parentId: id, rank: "0/1" as const }, archivedAt: null,
      createdAt: time, updatedAt: time, data: JSON.stringify(occupiedData) }
    doc = Automerge.change(doc, draft => { draft.entities[existingSource.id] = existingSource })
    const headsBeforeSourceConflict = Automerge.getHeads(doc)
    const sourceConflict = await execute(command("another-application", await sourceData("another-application", existingSourceId)))
    expect(sourceConflict.ok, "source ID already exists").toBe(false)
    expect(Automerge.getHeads(doc)).toEqual(headsBeforeSourceConflict)
  })

  it("Given mutable command input, When hashing begins, Then the captured title and source bytes alone are committed", async () => {
    const id = "application-1"
    const data = await sourceData(id)
    const originalText = (data.observation as AvailableObservation).text
    const input = command(id, data)
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const hashing = vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, bytes) => {
      input.title = "Mutated title during hashing"
      ;(data.observation as AvailableObservation).text = "Mutated evidence during hashing"
      return digest(algorithm, bytes)
    })
    try {
      const result = await execute(input)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.value.newDoc.entities[id]?.title).toBe("My application")
      const source = result.value.newDoc.entities[`application-source:${data.recordId}`]
      expect(source?.kind).toBe("application_source")
      if (source?.kind !== "application_source") return
      expect(JSON.parse(source.data).observation.text).toBe(originalText)
    } finally { hashing.mockRestore() }
  })
})
