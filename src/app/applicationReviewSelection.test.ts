import { describe, expect, it } from "vitest"
import { createWorkspaceDoc } from "../test/boardFixture"
import { canonicalizeJson, sha256Base64Url } from "../domain/identity"
import { parseAutomationDefinition, automationTypes, type AutomationDefinition } from "../domain/automationContract"
import type { ApplicationReviewOption, ApplicationReviewResponse } from "../domain/applicationReviewData"
import type { ApplicationSourceData, ApplicationSourceEntity } from "../domain/applicationSourceData"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { ItemWorkflow } from "../domain/archive"
import { validateApplicationReviewSelection } from "./applicationReviewSelection"

const time = "2026-10-14T10:00:00.000Z"
const origin = "https://automation.example.test"

type Fixture = {
  doc: WorkspaceDocumentV2
  source: ApplicationSourceData
  sourceHash: string
  option: ApplicationReviewOption
  review: ApplicationReviewResponse
  definition: AutomationDefinition
  workflow: ItemWorkflow
  boardId: string
  columnId: string
  cardId: string
}

async function fixture(sourceShape: "available" | "unavailable" | "legacy" | "refresh" = "available"): Promise<Fixture> {
  const doc = createWorkspaceDoc("workspace-1", "Applications", "owner-1", "job-search", time)
  const board = Object.values(doc.entities).find(entity => entity.kind === "board")!
  if (board.kind !== "board") throw new Error("Expected seeded board")
  const columnId = board.preset!.bindings["status.applied"]!
  const workflow = { columnId, changedAt: time }
  const cardId = "card-1"
  doc.entities[cardId] = { id: cardId, title: "Current editable title", body: "", values: {},
    placement: { parentId: columnId, rank: "0/1" }, archivedAt: null, createdAt: time, updatedAt: time,
    workflow: JSON.stringify(workflow) }

  const original = await sourceData("original-1", "available")
  let source = original
  if (sourceShape === "unavailable") source = await sourceData("original-1", "unavailable")
  if (sourceShape === "legacy") source = await sourceData("original-1", "legacy")
  if (sourceShape === "refresh") {
    source = await sourceData("refresh-1", "available", "refresh", original.recordId)
    addSourceEntity(doc, original)
  }
  addSourceEntity(doc, source)
  const sourceHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(source)))
  const option = optionFor(source, sourceHash, workflow)
  const definition = makeDefinition(doc.id, board.id)
  const review = makeReview(doc.id, definition.id, option)
  return { doc, source, sourceHash, option, review, definition, workflow, boardId: board.id, columnId, cardId }
}

async function sourceData(recordId: string, status: "available" | "unavailable" | "legacy", phase: "original" | "refresh" = "original",
  originalRecordId?: string): Promise<ApplicationSourceData> {
  const base = { phase: status === "legacy" ? "legacy" as const : phase, origin: status === "legacy" ? "legacy" as const : "website" as const, observedAt: time,
    ...(phase === "refresh" && originalRecordId ? { originalRecordId } : {}) }
  const observation = status === "available"
    ? { ...base, status, company: "Upvest", title: "Senior Product Engineer", text: "Build an investment API",
      extractorVersion: "job-page-v1", contentDigest: "D".repeat(43), jobUrl: "https://jobs.example.test/role/123" }
    : status === "legacy"
      ? { ...base, status: "missing-evidence" as const, reason: "Original posting evidence was not retained" }
      : { ...base, status, reason: "Job page could not be read" }
  return { kind: "application-source-observation", version: 1, recordId, workspaceId: "workspace-1", cardId: "card-1",
    applicationId: "workspace-1:card-1", observation } as ApplicationSourceData
}

function addSourceEntity(doc: WorkspaceDocumentV2, source: ApplicationSourceData): void {
  const entity: ApplicationSourceEntity = { id: `application-source:${source.recordId}`, kind: "application_source",
    title: "Application source", placement: { parentId: source.cardId, rank: "0/1" },
    archivedAt: null, createdAt: time, updatedAt: time, data: canonicalizeJson(source) }
  doc.entities[entity.id] = entity
}

function optionFor(source: ApplicationSourceData, sourceHash: string, workflow: ItemWorkflow): ApplicationReviewOption {
  return { cardId: source.cardId, displayTitle: "Senior Product Engineer", sourceRecordId: source.recordId, sourceHash,
    sourceTitle: source.observation.status === "available" ? source.observation.title : null,
    sourceCompany: source.observation.status === "available" ? source.observation.company : null,
    sourceStatus: source.observation.status, workflow: { ...workflow } }
}

function makeDefinition(workspaceId: string, boardId: string, overrides: Record<string, unknown> = {}): AutomationDefinition {
  return parseAutomationDefinition({ kind: "automation-definition", version: 1, id: "typed-intake", name: "Job intake",
    type: "job-intake", typeVersion: 2, parameters: { sources: ["email"] },
    permissions: [...automationTypes.find(type => type.version === 2)!.permissions],
    scope: { workspaceId, boardId, grantId: "grant-1" }, ...overrides })
}

function makeReview(workspaceId: string, definitionId: string, option: ApplicationReviewOption,
  overrides: Partial<ApplicationReviewResponse> = {}): ApplicationReviewResponse {
  return { kind: "automation-application-review", version: 1, origin, integrationId: "legacy-route", definitionId, workspaceId,
    eventId: "E".repeat(43), eventHash: "H".repeat(43), decisionHash: "D".repeat(43), decisionEvent: "rejection",
    status: "review", subject: "Application update", text: "The application was declined.", sentAt: time,
    grantId: "grant-1", accessEpoch: 1, automationState: "active", binding: null, options: [option], total: 1,
    offset: 0, hasMore: false, ...overrides }
}

describe("application review selection validation", () => {
  it("accepts exact original evidence and workflow after editable card labels change", async () => {
    const state = await fixture()
    const card = state.doc.entities[state.cardId]
    if (!card || "kind" in card) throw new Error("Expected card item")
    card.title = "Renamed since review"
    card.values.company = "Different display company"
    card.values.role = "Different display role"
    await expect(validateApplicationReviewSelection(state.review, state.option, state.doc, state.definition))
      .resolves.toEqual({ source: state.source, workflow: state.workflow })
  })

  it("accepts unavailable and legacy missing-evidence originals, but rejects no source and refresh as selected evidence", async () => {
    for (const shape of ["unavailable", "legacy"] as const) {
      const state = await fixture(shape)
      await expect(validateApplicationReviewSelection(state.review, state.option, state.doc, state.definition))
        .resolves.toMatchObject({ source: { observation: { phase: shape === "legacy" ? "legacy" : "original" } }, workflow: state.workflow })
    }
    const absent = await fixture()
    delete absent.doc.entities[`application-source:${absent.source.recordId}`]
    await expect(validateApplicationReviewSelection(absent.review, absent.option, absent.doc, absent.definition)).rejects.toThrow()

    const refresh = await fixture("refresh")
    await expect(validateApplicationReviewSelection(refresh.review, refresh.option, refresh.doc, refresh.definition)).rejects.toThrow()
  })

  it("rejects source scope or card mismatches and options outside the exact review page", async () => {
    const state = await fixture()
    const foreignSource = { ...state.source, workspaceId: "workspace-2", applicationId: `workspace-2:${state.cardId}` }
    const foreignEntity = state.doc.entities[`application-source:${state.source.recordId}`]
    if (!foreignEntity || foreignEntity.kind !== "application_source") throw new Error("Expected source entity")
    foreignEntity.data = canonicalizeJson(foreignSource)
    const foreignHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(foreignSource)))
    const foreignOption = optionFor(foreignSource, foreignHash, state.workflow)
    await expect(validateApplicationReviewSelection(makeReview(state.doc.id, state.definition.id, foreignOption), foreignOption,
      state.doc, state.definition)).rejects.toThrow()

    const wrongCard = await fixture()
    const wrongCardSource = { ...wrongCard.source, cardId: "other-card", applicationId: "workspace-1:other-card" }
    const wrongCardEntity = wrongCard.doc.entities[`application-source:${wrongCard.source.recordId}`]
    if (!wrongCardEntity || wrongCardEntity.kind !== "application_source") throw new Error("Expected source entity")
    wrongCardEntity.data = canonicalizeJson(wrongCardSource)
    const wrongCardHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(wrongCardSource)))
    const wrongCardOption = optionFor(wrongCardSource, wrongCardHash, wrongCard.workflow)
    await expect(validateApplicationReviewSelection(makeReview(wrongCard.doc.id, wrongCard.definition.id, wrongCardOption),
      wrongCardOption, wrongCard.doc, wrongCard.definition)).rejects.toThrow()

    const altered = await fixture()
    const alteredEntity = altered.doc.entities[`application-source:${altered.source.recordId}`]
    if (!alteredEntity || alteredEntity.kind !== "application_source") throw new Error("Expected source entity")
    const substituted = { ...altered.source, observation: { ...altered.source.observation,
      title: "Substituted title" } }
    alteredEntity.data = canonicalizeJson(substituted)
    await expect(validateApplicationReviewSelection(altered.review, altered.option, altered.doc, altered.definition)).rejects.toThrow()

    const fresh = await fixture()
    const unlisted = { ...fresh.option, displayTitle: "Changed page option" }
    await expect(validateApplicationReviewSelection(fresh.review, unlisted, fresh.doc, fresh.definition)).rejects.toThrow()
  })

  it("rejects stale workflow column or timestamp", async () => {
    const state = await fixture()
    const staleTime = { ...state.option, workflow: { ...state.workflow, changedAt: "2026-10-14T10:01:00.000Z" } }
    await expect(validateApplicationReviewSelection(makeReview(state.doc.id, state.definition.id, staleTime), staleTime,
      state.doc, state.definition)).rejects.toThrow()
    const staleColumn = { ...state.option, workflow: { ...state.workflow, columnId: "another-column" } }
    await expect(validateApplicationReviewSelection(makeReview(state.doc.id, state.definition.id, staleColumn), staleColumn,
      state.doc, state.definition)).rejects.toThrow()
  })

  it("rejects archived card, column or board", async () => {
    for (const target of ["card", "column", "board"] as const) {
      const state = await fixture()
      const entityId = target === "card" ? state.cardId : target === "column" ? state.columnId : state.boardId
      const entity = state.doc.entities[entityId]
      if (!entity) throw new Error(`Missing ${target}`)
      entity.archivedAt = time
      await expect(validateApplicationReviewSelection(state.review, state.option, state.doc, state.definition)).rejects.toThrow()
    }
  })

  it("rejects a mismatched definition scope, grant, board, workspace or route", async () => {
    const state = await fixture()
    const wrongDefinitions = [
      makeDefinition(state.doc.id, state.boardId, { id: "another-definition" }),
      makeDefinition("another-workspace", state.boardId),
      makeDefinition(state.doc.id, "another-board"),
      makeDefinition(state.doc.id, state.boardId, { scope: { workspaceId: state.doc.id, boardId: state.boardId, grantId: "another-grant" } }),
    ]
    for (const wrong of wrongDefinitions) {
      await expect(validateApplicationReviewSelection(state.review, state.option, state.doc, wrong)).rejects.toThrow()
    }
    await expect(validateApplicationReviewSelection(makeReview(state.doc.id, state.definition.id, state.option,
      { workspaceId: "another-workspace" }), state.option, state.doc, state.definition)).rejects.toThrow()
    await expect(validateApplicationReviewSelection(makeReview(state.doc.id, "another-definition", state.option),
      state.option, state.doc, state.definition)).rejects.toThrow()
  })

  it("rejects missing decision evidence and paused automation", async () => {
    const state = await fixture()
    await expect(validateApplicationReviewSelection(makeReview(state.doc.id, state.definition.id, state.option,
      { decisionHash: null }), state.option, state.doc, state.definition)).rejects.toThrow()
    await expect(validateApplicationReviewSelection(makeReview(state.doc.id, state.definition.id, state.option,
      { automationState: "paused" }), state.option, state.doc, state.definition)).rejects.toThrow()
  })
})
