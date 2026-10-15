import { z } from "zod"
import { canonicalizeJson } from "./identity"
import { isAutomationOrigin } from "./automationLifecycle"
import { parseApplicationBindingProof, type ApplicationBindingProof } from "./applicationBinding"

const MAX_RESPONSE_BYTES = 384 * 1024
const identifier = z.string().min(1).max(256).refine(value => Boolean(value.trim()))
const routeIdentifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const eventId = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/)
const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const nullableHash = hash.nullable()
const reviewStatus = z.enum(["pending", "processing", "review", "failed", "applied"])

const reviewBodySchema = z.strictObject({
  workspaceId: identifier,
  definitionId: routeIdentifier,
  integrationId: routeIdentifier,
  eventId,
  offset: z.number().int().min(0).max(1_000_000).default(0),
})
const unboundRetryBodySchema = reviewBodySchema.omit({ offset: true })
const listBodySchema = z.strictObject({ workspaceId: identifier, definitionId: routeIdentifier, integrationId: routeIdentifier })
const scopeBodySchema = z.strictObject({ workspaceId: identifier, definitionId: routeIdentifier })
const bindingBodySchema = z.strictObject({
  workspaceId: identifier,
  definitionId: routeIdentifier,
  integrationId: routeIdentifier,
  proof: z.unknown(),
})
const bindingReceiptSchema = z.strictObject({ bindingId: z.string().uuid(), duplicate: z.boolean() })
const retryReceiptSchema = z.strictObject({ eventId, status: reviewStatus, duplicate: z.boolean() })
const discoveryIntegrationSchema = z.strictObject({ integrationId: routeIdentifier, personId: identifier })
const discoverySchema = z.strictObject({
  origin: z.string().refine(isAutomationOrigin),
  workspaceId: identifier,
  definitionId: routeIdentifier,
  integrations: z.array(discoveryIntegrationSchema).max(64),
}).superRefine((discovery, context) => {
  const ids = discovery.integrations.map(value => value.integrationId)
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["integrations"], message: "Discovery has duplicate integration IDs" })
})
const mailboxEventSchema = z.strictObject({
  eventId,
  status: reviewStatus,
  createdAt: z.number().int().positive().refine(Number.isSafeInteger),
  subject: z.string().max(512),
  result: z.strictObject({ reason: z.string().max(2048).optional() }).optional(),
  bindingId: z.string().uuid().optional(),
})
const mailboxSchema = z.strictObject({
  origin: z.string().refine(isAutomationOrigin),
  workspaceId: identifier,
  definitionId: routeIdentifier,
  integrationId: routeIdentifier,
  route: z.strictObject({ address: z.string().max(320), mailbox: z.string().max(320) }).nullable(),
  receipt: z.strictObject({
    confirmation: z.strictObject({ eventId, url: z.string().url().regex(/^https:\/\/mail\.google\.com\//) }).nullable(),
    events: z.array(mailboxEventSchema).max(20),
  }),
  observation: z.unknown(),
})

const workflowSchema = z.strictObject({
  columnId: identifier,
  changedAt: z.string().min(1).max(64).refine(value => Number.isFinite(Date.parse(value))),
})
const optionSchema = z.strictObject({
  cardId: identifier,
  displayTitle: z.string().max(256),
  sourceRecordId: routeIdentifier.nullable(),
  sourceHash: nullableHash,
  sourceTitle: z.string().max(256).nullable(),
  sourceCompany: z.string().max(128).nullable(),
  sourceStatus: z.enum(["available", "pending", "not-found", "unavailable", "missing-evidence"]).nullable(),
  workflow: workflowSchema.nullable(),
}).superRefine((option, context) => {
  const evidenceFields = [option.sourceRecordId, option.sourceHash, option.sourceStatus]
  const evidencePresent = evidenceFields.filter(value => value !== null).length
  if (evidencePresent !== 0 && evidencePresent !== evidenceFields.length) {
    context.addIssue({ code: "custom", message: "Source identity, hash and status must be present together" })
  }
  if (option.sourceStatus === null && (option.sourceTitle !== null || option.sourceCompany !== null)) {
    context.addIssue({ code: "custom", message: "Source labels require source evidence" })
  }
  if (option.sourceStatus === "available" && (option.sourceTitle === null || option.sourceCompany === null)) {
    context.addIssue({ code: "custom", message: "Available source evidence requires title and company" })
  }
  if (option.sourceStatus !== null && option.sourceStatus !== "available" &&
    (option.sourceTitle !== null || option.sourceCompany !== null)) {
    context.addIssue({ code: "custom", message: "Incomplete source evidence cannot include title or company" })
  }
})

const responseSchema = z.strictObject({
  kind: z.literal("automation-application-review"),
  version: z.literal(1),
  origin: z.string().refine(isAutomationOrigin),
  integrationId: routeIdentifier,
  definitionId: routeIdentifier,
  workspaceId: identifier,
  eventId,
  eventHash: hash,
  decisionHash: nullableHash,
  decisionEvent: z.enum(["applied", "interview", "rejection", "uncertain", "unclassified"]),
  status: z.enum(["pending", "processing", "review", "failed", "applied"]),
  subject: z.string().max(512),
  text: z.string().max(48_000),
  sentAt: z.string().max(256).nullable(),
  grantId: identifier,
  accessEpoch: z.number().int().positive().refine(Number.isSafeInteger),
  automationState: z.enum(["active", "paused", "deleted"]),
  binding: z.unknown().nullable(),
  options: z.array(optionSchema).max(20),
  total: z.number().int().min(0).max(1_000_000),
  offset: z.number().int().min(0).max(1_000_000),
  hasMore: z.boolean(),
}).superRefine((response, context) => {
  const end = response.offset + response.options.length
  if (end > response.total) context.addIssue({ code: "custom", path: ["options"], message: "Review page exceeds total result count" })
  if (response.hasMore !== (end < response.total)) {
    context.addIssue({ code: "custom", path: ["hasMore"], message: "Review pagination flag does not match page bounds" })
  }
})

export type ApplicationReviewAction = "discover" | "list" | "review" | "bind" | "retry" | "retry-unbound"
export type ApplicationReviewOption = z.infer<typeof optionSchema>
export type ApplicationBindingReceipt = z.infer<typeof bindingReceiptSchema>
export type ApplicationRetryReceipt = z.infer<typeof retryReceiptSchema>
export type ApplicationReviewDiscovery = z.infer<typeof discoverySchema>
export type ApplicationReviewMailbox = z.infer<typeof mailboxSchema>
export type ApplicationReviewResponse = Omit<z.infer<typeof responseSchema>, "binding"> & {
  binding: ApplicationBindingProof | null
}
export type ApplicationReviewBody =
  | z.infer<typeof scopeBodySchema>
  | z.infer<typeof listBodySchema>
  | z.infer<typeof reviewBodySchema>
  | z.infer<typeof unboundRetryBodySchema>
  | { workspaceId: string; definitionId: string; integrationId: string; proof: ApplicationBindingProof }

/** Parse an exact request body and detach every returned field from caller-owned input. */
export function parseApplicationReviewBody(action: ApplicationReviewAction, value: unknown): ApplicationReviewBody {
  const snapshot = captureJson(value)
  if (action === "discover") return scopeBodySchema.parse(snapshot)
  if (action === "list") return listBodySchema.parse(snapshot)
  if (action === "review") return reviewBodySchema.parse(snapshot)
  if (action === "retry-unbound") return unboundRetryBodySchema.parse(snapshot)
  if (action === "bind" || action === "retry") {
    const body = bindingBodySchema.parse(snapshot)
    return { ...body, proof: parseApplicationBindingProof(body.proof) }
  }
  throw new TypeError("Unknown application review action")
}

/** Parse a bounded mailbox response while leaving its signed observation opaque for domain verification. */
export function parseApplicationReviewMailbox(value: unknown): ApplicationReviewMailbox {
  return mailboxSchema.parse(captureJson(value))
}

/** Parse a detached, strictly bounded Worker response before application code uses it. */
export function parseApplicationReviewResponse(value: unknown): ApplicationReviewResponse {
  const snapshot = captureJson(value)
  const response = responseSchema.parse(snapshot)
  const binding = response.binding === null ? null : parseApplicationBindingProof(response.binding)
  if (binding) {
    const payload = binding.signed.payload
    for (const [key, expected] of Object.entries({ origin: response.origin, integrationId: response.integrationId,
      definitionId: response.definitionId, workspaceId: response.workspaceId, eventId: response.eventId,
      eventHash: response.eventHash })) {
      if (payload[key as keyof typeof payload] !== expected) throw new Error(`Application review binding ${key} does not match response`)
    }
  }
  return { ...response, binding } as ApplicationReviewResponse
}

/** Parse an action-specific mutation receipt without accepting cross-action response fields. */
export function parseApplicationReviewReceipt(action: "bind", value: unknown): ApplicationBindingReceipt
export function parseApplicationReviewReceipt(action: "retry", value: unknown): ApplicationRetryReceipt
export function parseApplicationReviewReceipt(action: "bind" | "retry", value: unknown): ApplicationBindingReceipt | ApplicationRetryReceipt
export function parseApplicationReviewReceipt(action: "bind" | "retry", value: unknown): ApplicationBindingReceipt | ApplicationRetryReceipt {
  const snapshot = captureJson(value)
  if (action === "bind") return bindingReceiptSchema.parse(snapshot)
  return retryReceiptSchema.parse(snapshot)
}

/** Parse the signed-origin discovery result and reject ambiguous duplicate integrations. */
export function parseApplicationReviewDiscovery(value: unknown): ApplicationReviewDiscovery {
  return discoverySchema.parse(captureJson(value))
}

function captureJson(value: unknown): unknown {
  let snapshot: unknown
  try { snapshot = structuredClone(value) }
  catch { throw new TypeError("Application review data is not cloneable JSON") }
  let encoded: string
  try { encoded = canonicalizeJson(snapshot) }
  catch { throw new TypeError("Application review data is not canonical JSON") }
  if (new TextEncoder().encode(encoded).byteLength > MAX_RESPONSE_BYTES) {
    throw new TypeError("Application review data exceeds the size limit")
  }
  return snapshot
}
