import { describe, expect, it } from "vitest"
import { canonicalizeJson } from "./identity"
import { assertApplicationSourceRecord, MAX_APPLICATION_SOURCE_BYTES, parseApplicationSourceData, readApplicationSourceData } from "./applicationSourceData"
import { assertWorkspaceEntityTransitions } from "./permissions"
import { createWorkspaceDoc } from "./seeds"
import { validateEntity, type WorkspaceDocumentV2, type WorkspaceEntity } from "./model"

const time = "2026-10-14T10:00:00.000Z"

function observation(overrides: Record<string, unknown> = {}) {
  return { phase: "original", origin: "website", status: "available", observedAt: time,
    jobUrl: "https://jobs.example.test/opening/42", company: "Nacre Light", title: "Principal Systems Engineer",
    text: "Build and operate reliable distributed systems.", extractorVersion: "jsonld-1", contentDigest: "a".repeat(43),
    ...overrides }
}

function sourceData(overrides: Record<string, unknown> = {}) {
  return { kind: "application-source-observation", version: 1, recordId: "source-original", workspaceId: "workspace",
    cardId: "card", applicationId: "workspace:card", observation: observation(), ...overrides }
}

function sourceEntity(overrides: Record<string, unknown> = {}) {
  return { id: "application-source:source-original", kind: "application_source", title: "Application source",
    placement: { parentId: "card", rank: "0/1" }, archivedAt: null, createdAt: time, updatedAt: time,
    data: canonicalizeJson(sourceData()), ...overrides }
}

function entitiesWithSource(source: ReturnType<typeof sourceEntity> = sourceEntity()) {
  const entities = { card: { id: "card", title: "Edited role label", body: "", values: {} },
    [source.id]: source } as unknown as Record<string, WorkspaceEntity>
  return entities
}

describe("application source data reader", () => {
  it("Given an available original posting, When reading canonical data, Then preserve extracted evidence independently of the editable card", () => {
    const data = sourceData()
    const canonical = canonicalizeJson(data)
    expect(readApplicationSourceData(canonical)).toEqual(data)
    expect(validateEntity(sourceEntity()).ok).toBe(true)
    const card = { ...entitiesWithSource()["card"]!, title: "A different editable label" }
    expect(card.title).toBe("A different editable label")
    expect(readApplicationSourceData(canonical).observation).toMatchObject({
      phase: "original", company: "Nacre Light", title: "Principal Systems Engineer",
    })
  })

  it("Given valid data, When JSON is noncanonical, oversized in UTF-8 bytes, or carries unknown/future fields, Then reject it", () => {
    const canonical = canonicalizeJson(sourceData())
    expect(() => readApplicationSourceData(` ${canonical}`)).toThrow(/canonical/i)
    const unicodeData = sourceData({ observation: observation({ text: "界".repeat(22_000) }) })
    const unicodeJson = canonicalizeJson(unicodeData)
    expect(new TextEncoder().encode(unicodeJson).length).toBeGreaterThan(MAX_APPLICATION_SOURCE_BYTES)
    expect(() => readApplicationSourceData(unicodeJson)).toThrow(/byte limit/i)
    expect(() => parseApplicationSourceData({ ...sourceData(), future: true })).toThrow()
    expect(() => parseApplicationSourceData({ ...sourceData(), version: 2 })).toThrow()
    expect(() => parseApplicationSourceData({ ...sourceData(), observation: observation({ futureEvidence: "hidden" }) })).toThrow()
  })

  it("Given a pending source, When it supplies title or extracted text, Then reject invented original evidence", () => {
    const pending = { phase: "original", origin: "website", status: "pending", observedAt: time, reason: "Page fetch pending" }
    expect(parseApplicationSourceData(sourceData({ observation: pending })).observation.status).toBe("pending")
    for (const extra of [{ title: "Guess" }, { text: "Guessed posting text" }, { contentDigest: "a".repeat(43) }]) {
      expect(() => parseApplicationSourceData(sourceData({ observation: { ...pending, ...extra } }))).toThrow()
    }
  })

  it("Given a legacy card, When its source is marked legacy, Then only missing-evidence is accepted", () => {
    const legacy = sourceData({ recordId: "legacy-source", observation: {
      phase: "legacy", origin: "legacy", status: "missing-evidence", observedAt: time,
      reason: "No original posting was retained",
    } })
    expect(parseApplicationSourceData(legacy).observation).toMatchObject({ status: "missing-evidence", phase: "legacy" })
    expect(() => parseApplicationSourceData({ ...legacy, observation: { ...legacy.observation as object, title: "Current card label" } })).toThrow()
    expect(() => parseApplicationSourceData({ ...legacy, observation: { ...legacy.observation as object, status: "pending" } })).toThrow()
  })

  it("Given a non-legacy source, When status uses the legacy missing-evidence marker, Then reject it", () => {
    expect(() => parseApplicationSourceData(sourceData({ observation: {
      phase: "original", origin: "website", status: "missing-evidence", observedAt: time,
    } }))).toThrow()
    expect(() => parseApplicationSourceData(sourceData({ recordId: "source-refresh", observation: {
      phase: "refresh", origin: "website", status: "missing-evidence", observedAt: time,
      originalRecordId: "source-original",
    } }))).toThrow()
  })

  it("Given an original record, When a refresh references another application or a chained refresh, Then reject it", () => {
    const original = sourceEntity()
    const entities = entitiesWithSource(original)
    const refresh = sourceEntity({ id: "application-source:source-refresh", data: canonicalizeJson(sourceData({
      recordId: "source-refresh", observation: observation({ phase: "refresh", originalRecordId: "source-original" }),
    })) })
    expect(assertApplicationSourceRecord(refresh, entities, "workspace").observation.phase).toBe("refresh")
    entities[refresh.id] = refresh as unknown as WorkspaceEntity
    const chained = sourceEntity({ id: "application-source:chained", data: canonicalizeJson(sourceData({
      recordId: "chained", observation: observation({ phase: "refresh", originalRecordId: "source-refresh" }),
    })) })
    expect(() => assertApplicationSourceRecord(chained, entities, "workspace")).toThrow(/original application/i)
    for (const changed of [
      sourceData({ applicationId: "workspace:another-card", observation: observation({ phase: "refresh", originalRecordId: "source-original" }) }),
      sourceData({ recordId: "source-refresh", observation: observation({ phase: "refresh", originalRecordId: "source-refresh" }) }),
    ]) {
      const invalid = { ...refresh, data: canonicalizeJson(changed) }
      expect(() => assertApplicationSourceRecord(invalid, entities, "workspace")).toThrow()
    }
    const wrongPlacement = { ...refresh, placement: { parentId: "another-card", rank: "0/1" } }
    expect(() => assertApplicationSourceRecord(wrongPlacement, entities, "workspace")).toThrow(/scope|parent/i)
    expect(() => assertApplicationSourceRecord(refresh, entities, "another-workspace")).toThrow(/scope|parent/i)
  })

  it("Given a source entity, When its ID prefix or kind is disguised or an ordinary entity reuses its reserved ID, Then reject it", () => {
    const entities = entitiesWithSource()
    expect(() => assertApplicationSourceRecord({ ...sourceEntity(), id: "ordinary-source" }, entities, "workspace")).toThrow()
    expect(() => assertApplicationSourceRecord({ ...sourceEntity(), kind: "item" }, entities, "workspace")).toThrow()

    const before = createWorkspaceDoc("workspace", "Applications", "owner", "blank")
    const after: WorkspaceDocumentV2 = structuredClone(before)
    after.entities["application-source:reserved"] = {
      id: "application-source:reserved", title: "ordinary item", body: "", values: {},
      placement: { parentId: null, rank: "0/1" }, archivedAt: null, createdAt: time, updatedAt: time,
    }
    expect(() => assertWorkspaceEntityTransitions("editor", before.entities, after.entities,
      new Set(["application-source:reserved"]), "editor", "workspace")).toThrow()
  })

  it("Given a source entity, When a refresh is presented as the original entity, Then reject unstable entity timestamps", () => {
    expect(validateEntity(sourceEntity({ createdAt: time, updatedAt: "2026-10-14T10:01:00.000Z" }))).toMatchObject({ ok: false })
  })
})
