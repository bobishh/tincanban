import { z } from "zod"
import { isMemberProfileData, MAX_AVATAR_DATA_URL_LENGTH } from "./avatarData"
import { isValidRank } from "./rank"
import { isAutomationDefinitionData, isAutomationControlData, isAutomationOrigin } from "./automationLifecycle"
import { isAutomationApprovalData } from "./automationApproval"
import { applicationSourceEntitySchema, type ApplicationSourceEntity } from "./applicationSourceData"

const id = z.string().min(1)
const rank = z.string().refine(isValidRank, "Invalid canonical rank")
const placementSchema = z.strictObject({ parentId: z.string().nullable(), rank })
const entityBaseSchema = z.strictObject({
  id, title: z.string(), placement: placementSchema,
  archivedAt: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
})
const common = entityBaseSchema.shape
const fieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
const priorityRuleSchema = z.strictObject({
  id,
  fieldId: id,
  operator: z.enum(["equals", "contains", "at_least", "at_most", "is_set"]),
  value: fieldValueSchema,
  weight: z.number().min(-10).max(10),
})
const priorityBandSchema = z.strictObject({ optionId: id, minScore: z.number().min(0).max(10) })
export const cardAgingPolicySchema = z.strictObject({
  version: z.literal(1),
  thresholds: z.strictObject({ watch: z.number().int().positive(), aged: z.number().int().positive(), overdue: z.number().int().positive() }).refine(
    ({ watch, aged, overdue }) => watch < aged && aged < overdue,
    "Aging thresholds must increase from watch to aged to overdue",
  ),
})
export const employeeProfileSchema = z.strictObject({ stack: z.string().max(4000), work_profile: z.string().max(8000) })
export const priorityPolicySchema = z.strictObject({
  version: z.literal(1),
  evaluator: z.enum(["weighted-rules-v1", "job-fit-v1"]),
  assessmentFieldId: id.optional(),
  sort: z.enum(["fit_desc", "fit_asc", "manual"]).optional(),
  priorityFieldId: id,
  fitFieldId: id.nullable(),
  rules: z.array(priorityRuleSchema),
  bands: z.array(priorityBandSchema),
})
const boardSchema = z.strictObject({
  ...common, kind: z.literal("board"), entityName: z.string().refine(value => Boolean(value.trim())).optional(),
  preset: z.strictObject({ key: z.enum(["job-search", "blank"]), version: z.literal(1), bindings: z.record(z.string(), z.string()) }).nullable(),
  cardStageButtons: z.array(z.strictObject({ columnId: id, label: z.string().min(1).optional() })).optional(),
  priorityPolicy: priorityPolicySchema.nullable().optional(),
  employee_profile: employeeProfileSchema.optional(),
  cardAgingPolicy: cardAgingPolicySchema.optional(),
  archiveColumnId: id.nullable().optional(),
})
const columnSchema = z.strictObject({
  ...common,
  kind: z.literal("column"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  archive: z.literal(true).optional(),
  collapsible: z.boolean().optional(),
})
const itemLifecycleSchema = z.strictObject({ state: z.enum(["active", "archived"]), changedAt: z.string() })
const itemWorkflowSchema = z.strictObject({ columnId: id, changedAt: z.string() })
const itemSchema = z.strictObject({ ...common, archivedAt: z.string().nullable().optional(), body: z.string(), values: z.record(z.string(), fieldValueSchema), lastActivityAt: z.string().optional(), lifecycle: z.union([z.string(), itemLifecycleSchema]).optional(), workflow: z.union([z.string(), itemWorkflowSchema]).optional() })
const fieldOptionSchema = z.strictObject({ id: z.string(), title: z.string(), rank, archivedAt: z.string().nullable() })
const fieldBase = { ...common, kind: z.literal("field"), required: z.boolean() }
const fieldSchema = z.discriminatedUnion("valueType", [
  z.strictObject({ ...fieldBase, valueType: z.enum(["text", "url", "date", "datetime", "boolean"]) }),
  z.strictObject({ ...fieldBase, valueType: z.literal("number"), min: z.number().nullable(), max: z.number().nullable() }),
  z.strictObject({ ...fieldBase, valueType: z.literal("select"), options: z.record(z.string(), fieldOptionSchema) }),
])
export const fileReferenceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("blob"),
    sha256: z.string().optional(),
    hash: z.string().optional(),
    ticket: z.string().optional(),
    byteLength: z.number().int().nonnegative(),
    mimeType: z.string(),
    fileName: z.string(),
  }),
  z.strictObject({ type: z.literal("local-file"), fileId: z.string(), fileName: z.string() }),
])
const documentSchema = z.strictObject({
  ...common, kind: z.literal("document"), documentKind: z.enum(["cv", "cover_letter", "note", "attachment"]),
  format: z.enum(["markdown", "html", "pdf", "file", "path"]), content: z.string().nullable(), file: fileReferenceSchema.nullable(),
})
const templateSchema = z.strictObject({ ...common, kind: z.literal("document_template"), markdown: z.string() })
const legacyTemplateSchema = z.strictObject({ ...common, kind: z.literal("template"), markdown: z.string(), templateKind: z.string().optional() })
const artifactSchema = z.strictObject({
  ...common, kind: z.literal("artifact"), artifactKind: z.enum(["cv", "cover_letter"]), templateId: z.string(),
  pdf: fileReferenceSchema, sourceMarkdown: fileReferenceSchema.nullable(),
})
const memberProfileSchema = z.strictObject({
  ...common, kind: z.literal("member_profile"), personId: id,
  data: z.string().max(MAX_AVATAR_DATA_URL_LENGTH + 100).refine(isMemberProfileData),
})
const automationSchema = z.strictObject({
  ...common, kind: z.literal("automation"),
  definition: z.string().max(8192).refine(isAutomationDefinitionData),
  approval: z.string().max(32768).refine(isAutomationApprovalData),
  executor: z.strictObject({ origin: z.string().max(2048).refine(isAutomationOrigin), personId: id }),
  controls: z.record(z.string(), z.string().max(8192).refine(isAutomationControlData)),
})
export const entitySchema = z.union([
  boardSchema, columnSchema, fieldSchema, documentSchema, templateSchema, legacyTemplateSchema, artifactSchema, itemSchema, memberProfileSchema, automationSchema, applicationSourceEntitySchema,
])
export const workspaceSchema = z.strictObject({
  kind: z.literal("workspace"), formatVersion: z.literal(3), id, title: z.string(), archivedAt: z.string().nullable(), ownerPersonId: z.string(),
  entities: z.record(z.string(), entitySchema),
  migration: z.strictObject({ migrationId: z.string(), sourceFormat: z.literal("match-0.0.1"), sourceHeads: z.array(z.string()) }).nullable(),
  leads: z.array(z.unknown()).optional(), documents: z.array(z.unknown()).optional(),
  templates: z.array(z.unknown()).optional(), artifacts: z.array(z.unknown()).optional(),
})
export type Board = z.infer<typeof boardSchema>
export type Column = z.infer<typeof columnSchema>
export type FieldValue = z.infer<typeof fieldValueSchema>
export type PriorityRule = z.infer<typeof priorityRuleSchema>
export type PriorityPolicy = z.infer<typeof priorityPolicySchema>
export type CardAgingPolicy = z.infer<typeof cardAgingPolicySchema>
export type Item = z.infer<typeof itemSchema> & { readonly kind?: never }
export type FieldDefinition = z.infer<typeof fieldSchema>
export type FileReference = z.infer<typeof fileReferenceSchema>
export type AttachedDocument = z.infer<typeof documentSchema>
export type DocumentTemplate = z.infer<typeof templateSchema>
export type LegacyWritingTemplate = z.infer<typeof legacyTemplateSchema>
export type PdfArtifact = z.infer<typeof artifactSchema>
type MemberProfile = z.infer<typeof memberProfileSchema>
type AutomationEntity = z.infer<typeof automationSchema>
export type WorkspaceEntity = Board | Column | Item | FieldDefinition | AttachedDocument | DocumentTemplate | LegacyWritingTemplate | PdfArtifact | MemberProfile | AutomationEntity | ApplicationSourceEntity
export type WorkspaceDocumentV2 = Omit<z.infer<typeof workspaceSchema>, "entities"> & { entities: Record<string, WorkspaceEntity> }

export type EntityKind = Exclude<WorkspaceEntity, Item>["kind"] | "item"

export function isItem(entity: unknown): entity is Item {
  if (!entity || typeof entity !== "object") return false
  const candidate = entity as Record<string, unknown>
  return typeof candidate.id === "string" && typeof candidate.title === "string" &&
    typeof candidate.body === "string" && Boolean(candidate.values) && typeof candidate.values === "object" &&
    Boolean(candidate.placement) && typeof candidate.placement === "object"
}

export function hasEntityKind<K extends Exclude<EntityKind, "item">>(
  entity: WorkspaceEntity | null | undefined,
  kind: K,
): entity is Extract<Exclude<WorkspaceEntity, Item>, { kind: K }> {
  return Boolean(entity && "kind" in entity && entity.kind === kind)
}

export function entityKind(entity: WorkspaceEntity): EntityKind {
  return isItem(entity) ? "item" : entity.kind
}
