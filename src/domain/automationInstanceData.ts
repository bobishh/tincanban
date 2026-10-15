import { z } from "zod"
import { canonicalizeJson, fromBase64Url, toBase64Url } from "./identity"
import { isAutomationOrigin } from "./automationLifecycle"
import type { AutomationInstanceAction } from "./automationInstanceProtocol"

const MAX_AUTOMATION_INSTANCE_BODY_BYTES = 24 * 1024 * 1024
const MAX_AUTOMATION_INSTANCE_RECEIPT_BYTES = 128 * 1024
const identifier = z.string().min(1).max(256).refine(value => Boolean(value.trim()))
const routeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const scopeFields = { workspaceId: identifier, definitionId: routeId, executorPersonId: identifier }
const discoverBodySchema = z.strictObject(scopeFields)
const identityBodySchema = z.strictObject({ ...scopeFields, integrationId: routeId })
const activateBodySchema = z.strictObject({ ...scopeFields, integrationId: routeId,
  packet: z.unknown().refine(value => value !== undefined, "Activation packet is required"), adoptLegacy: z.boolean() })
const servicePublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/).refine(value => {
  try {
    const bytes = fromBase64Url(value)
    return bytes.length === 32 && toBase64Url(bytes) === value
  } catch { return false }
})
const storagePinFields = { origin: z.string().refine(isAutomationOrigin), scopeId: routeId,
  keyEpoch: z.number().int().positive().refine(Number.isSafeInteger), servicePublicKey }
const storagePinSchema = z.strictObject(storagePinFields)
const storageDescriptionSchema = z.strictObject({ ...storagePinFields,
  policyRevision: z.number().int().positive().refine(Number.isSafeInteger), minimumWriterVersion: z.literal(2).optional() })
const refreshAccessBodySchema = z.strictObject({ ...scopeFields, integrationId: routeId, storage: storagePinSchema,
  receipt: z.unknown().refine(value => value !== undefined && isBoundedReceipt(value), "Storage receipt must be bounded JSON") })
const descriptionSchema = z.strictObject({
  workspaceId: identifier,
  boardId: identifier,
  definitionId: routeId.nullable(),
  executorPersonId: identifier,
  grantId: identifier,
  expiresAt: z.number().int().positive().refine(Number.isSafeInteger),
  state: z.enum(["active", "paused", "deleted"]),
  adoptionRequired: z.boolean(),
  storage: storageDescriptionSchema.optional(),
}).superRefine((description, context) => {
  if ((description.definitionId === null) !== description.adoptionRequired) {
    context.addIssue({ code: "custom", path: ["adoptionRequired"], message: "Adoption must match missing definition identity" })
  }
})
const discoveryIntegrationSchema = z.strictObject({ integrationId: routeId })
const discoverySchema = z.strictObject({
  origin: z.string().refine(isAutomationOrigin),
  workspaceId: identifier,
  definitionId: routeId,
  executorPersonId: identifier,
  integrations: z.array(discoveryIntegrationSchema).max(64),
}).superRefine((discovery, context) => {
  const values = discovery.integrations.map(value => value.integrationId)
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path: ["integrations"], message: "Automation discovery has duplicate integration IDs" })
  }
})
const expectedDiscoverySchema = z.strictObject({
  origin: z.string().refine(isAutomationOrigin), workspaceId: identifier, definitionId: routeId, executorPersonId: identifier,
})

export type AutomationInstanceDescription = z.infer<typeof descriptionSchema>
export type AutomationInstanceDiscovery = z.infer<typeof discoverySchema>
export type AutomationInstanceDiscoveryExpected = z.input<typeof expectedDiscoverySchema>
export type AutomationInstanceBody = z.infer<typeof discoverBodySchema> | z.infer<typeof identityBodySchema> |
  z.infer<typeof activateBodySchema> | z.infer<typeof refreshAccessBodySchema>
export type AutomationInstanceDiscoverBody = z.infer<typeof discoverBodySchema>
export type AutomationInstanceIdentityBody = z.infer<typeof identityBodySchema>
export type AutomationInstanceActivateBody = z.infer<typeof activateBodySchema>
export type AutomationInstanceRefreshBody = z.infer<typeof refreshAccessBodySchema>

/** Parse and detach one exact instance API request body. Packet semantics are checked by activation validation. */
export function parseAutomationInstanceBody(action: "discover", value: unknown): AutomationInstanceDiscoverBody
export function parseAutomationInstanceBody(action: "identity", value: unknown): AutomationInstanceIdentityBody
export function parseAutomationInstanceBody(action: "activate", value: unknown): AutomationInstanceActivateBody
export function parseAutomationInstanceBody(action: "refresh-access", value: unknown): AutomationInstanceRefreshBody
export function parseAutomationInstanceBody(action: AutomationInstanceAction, value: unknown): AutomationInstanceBody
export function parseAutomationInstanceBody(action: AutomationInstanceAction, value: unknown): AutomationInstanceBody {
  const snapshot = capture(value)
  switch (action) {
    case "discover": return discoverBodySchema.parse(snapshot)
    case "identity": return identityBodySchema.parse(snapshot)
    case "activate": return activateBodySchema.parse(snapshot)
    case "refresh-access": return refreshAccessBodySchema.parse(snapshot)
  }
}

function isBoundedReceipt(value: unknown): boolean {
  try { return new TextEncoder().encode(canonicalizeJson(value)).byteLength <= MAX_AUTOMATION_INSTANCE_RECEIPT_BYTES }
  catch { return false }
}

/** Parse the strict, workspace-bound public owner description. */
export function parseAutomationInstanceDescription(value: unknown): AutomationInstanceDescription {
  return descriptionSchema.parse(capture(value))
}

/** Parse and verify discovery echoes the request coordinates exactly. */
export function parseAutomationInstanceDiscovery(value: unknown,
  expectedValue: AutomationInstanceDiscoveryExpected): AutomationInstanceDiscovery {
  const discovery = discoverySchema.parse(capture(value))
  const expected = expectedDiscoverySchema.parse(capture(expectedValue))
  for (const key of ["origin", "workspaceId", "definitionId", "executorPersonId"] as const) {
    if (discovery[key] !== expected[key]) throw new Error(`Automation discovery ${key} does not match request`)
  }
  return discovery
}

function capture(value: unknown): unknown {
  let snapshot: unknown
  try { snapshot = structuredClone(value) }
  catch { throw new TypeError("Automation instance DTO is not cloneable JSON") }
  let encoded: string
  try { encoded = canonicalizeJson(snapshot) }
  catch { throw new TypeError("Automation instance DTO is not canonical JSON data") }
  if (new TextEncoder().encode(encoded).byteLength > MAX_AUTOMATION_INSTANCE_BODY_BYTES) {
    throw new TypeError("Automation instance DTO exceeds the size limit")
  }
  return snapshot
}
