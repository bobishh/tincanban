import { z } from "zod"
import { canonicalizeJson } from "./identity"
import type { WorkspaceEntity } from "./entitySchemas"

export const MAX_APPLICATION_SOURCE_BYTES = 65_536
const recordId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const identifier = z.string().min(1).max(256)
const requiredText = (maximum: number) => z.string().min(1).max(maximum).refine(value => Boolean(value.trim()))
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
const jobUrl = z.string().max(4096).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password }
  catch { return false }
})
const observationBase = {
  phase: z.enum(["original", "refresh", "legacy"]), origin: z.enum(["website", "email", "manual", "legacy"]),
  observedAt: iso, jobUrl: jobUrl.optional(), originalRecordId: recordId.optional(),
}
const observationSchema = z.union([
  z.strictObject({ ...observationBase, status: z.literal("available"),
    company: requiredText(512), title: requiredText(2048), text: requiredText(48_000),
    extractorVersion: requiredText(128), contentDigest: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  z.strictObject({ ...observationBase, status: z.enum(["pending", "not-found", "unavailable", "missing-evidence"]),
    reason: z.string().max(2048).optional() }),
]).refine(value => (value.phase === "refresh") === (value.originalRecordId !== undefined) &&
  (value.phase === "legacy" ? value.origin === "legacy" && value.status === "missing-evidence"
    : value.origin !== "legacy" && value.status !== "missing-evidence"))

const dataSchema = z.strictObject({ kind: z.literal("application-source-observation"), version: z.literal(1),
  recordId, workspaceId: identifier, cardId: identifier, applicationId: z.string().min(1).max(513), observation: observationSchema,
}).refine(value => value.applicationId === `${value.workspaceId}:${value.cardId}`)

export type ApplicationSourceData = z.infer<typeof dataSchema>
export function parseApplicationSourceData(value: unknown): ApplicationSourceData { return dataSchema.parse(value) }
export function readApplicationSourceData(data: string): ApplicationSourceData {
  if (new TextEncoder().encode(data).length > MAX_APPLICATION_SOURCE_BYTES) throw new Error("Application source exceeds byte limit")
  const parsed = parseApplicationSourceData(JSON.parse(data))
  if (canonicalizeJson(parsed) !== data) throw new Error("Application source must use canonical JSON")
  return parsed
}

export const applicationSourceEntitySchema = z.strictObject({
  id: z.string().regex(/^application-source:[A-Za-z0-9_-]{1,128}$/), kind: z.literal("application_source"),
  title: z.literal("Application source"), placement: z.strictObject({ parentId: identifier, rank: z.literal("0/1") }),
  archivedAt: z.null(), createdAt: iso, updatedAt: iso,
  data: z.string().max(MAX_APPLICATION_SOURCE_BYTES).refine(value => {
    try { readApplicationSourceData(value); return true } catch { return false }
  }),
}).refine(value => value.createdAt === value.updatedAt)
export type ApplicationSourceEntity = z.infer<typeof applicationSourceEntitySchema>

export function assertApplicationSourceRecord(value: unknown, entities: Record<string, WorkspaceEntity>, workspaceId?: string): ApplicationSourceData {
  const entity = applicationSourceEntitySchema.parse(value), data = readApplicationSourceData(entity.data)
  const parent = entities[data.cardId]
  if (entity.id !== `application-source:${data.recordId}` || entity.placement.parentId !== data.cardId ||
    (workspaceId !== undefined && data.workspaceId !== workspaceId) || !parent || parent.kind !== undefined ||
    !("body" in parent) || !("values" in parent)) throw new Error("Application source scope or parent is invalid")
  assertOriginalReference(data, entities)
  return data
}

function assertOriginalReference(data: ApplicationSourceData, entities: Record<string, WorkspaceEntity>): void {
  if (data.observation.phase !== "refresh") return
  const original = entities[`application-source:${data.observation.originalRecordId}`]
  if (original?.kind !== "application_source") throw new Error("Original application source is missing")
  const prior = readApplicationSourceData(original.data)
  if (prior.observation.phase !== "original" || prior.applicationId !== data.applicationId ||
    prior.workspaceId !== data.workspaceId || prior.cardId !== data.cardId || prior.recordId === data.recordId) {
    throw new Error("Application source refresh must reference its original application")
  }
}
