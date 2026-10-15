import { z } from "zod"
import type { SignedEnvelope } from "./identity"
import { isAutomationOrigin } from "./automationLifecycle"
import type { VerifiedSigningContext } from "./signingContext"
import { publicDeviceProofFields } from "./deviceProof"
import type { DeviceCertificate } from "./model"
import { captureFreshDeviceJson, createFreshDeviceRequest, freshDeviceRequestFields, freshDeviceRequestMetadata, verifyFreshDeviceRequest } from "./freshDeviceRequest"

const identifier = z.string().min(1).max(256).refine(value => Boolean(value.trim()))
const routeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const actionSchema = z.enum(["discover", "identity", "activate", "refresh-access", "prepare-storage-rotation", "rotate-storage", "prepare-history-baseline", "activate-history-baseline"])
const requestFields = {
  action: actionSchema,
  origin: z.string().refine(isAutomationOrigin),
  workspaceId: identifier,
  definitionId: routeId,
  integrationId: routeId.nullable(),
  executorPersonId: identifier,
  bodyHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}
const inputSchema = z.strictObject(requestFields).superRefine((input, context) => {
  if ((input.action === "discover") !== (input.integrationId === null)) {
    context.addIssue({ code: "custom", path: ["integrationId"], message: "Only discovery may omit the integration ID" })
  }
})
const payloadSchema = z.strictObject({
  kind: z.literal("automation-instance-request"),
  version: z.literal(1),
  ...requestFields,
  ...freshDeviceRequestFields,
})
const signedSchema = z.strictObject({ signerKeyId: identifier, signature: z.string().min(1).max(128), payload: payloadSchema })
const proofSchema = z.strictObject({ ...publicDeviceProofFields, signed: signedSchema })
const expectedSchema = z.strictObject(requestFields).superRefine((expected, context) => {
  if ((expected.action === "discover") !== (expected.integrationId === null)) {
    context.addIssue({ code: "custom", path: ["integrationId"], message: "Only discovery may omit the integration ID" })
  }
})

export type AutomationInstanceAction = z.infer<typeof actionSchema>
export type AutomationInstanceRequestInput = z.input<typeof inputSchema>
export type AutomationInstanceRequestPayload = z.output<typeof payloadSchema>
export type AutomationInstanceRequestProof = {
  publicKey: string
  certificates: DeviceCertificate[]
  signed: SignedEnvelope<AutomationInstanceRequestPayload>
}
export type AutomationInstanceRequestExpected = z.input<typeof expectedSchema>

/** Sign an exact, short-lived instance request under a verified live signing context. */
export async function createAutomationInstanceRequest(context: VerifiedSigningContext,
  inputValue: AutomationInstanceRequestInput): Promise<AutomationInstanceRequestProof> {
  const input = inputSchema.parse(captureFreshDeviceJson(inputValue, "Automation instance request"))
  const now = Date.now()
  const payload = { ...input, kind: "automation-instance-request", version: 1,
    ...freshDeviceRequestMetadata(context, now) }
  return createFreshDeviceRequest(context, payload, payloadSchema, proofSchema, "Automation instance") as
    Promise<AutomationInstanceRequestProof>
}

/** Verify request freshness, every caller-supplied coordinate and its complete device chain. */
export async function verifyAutomationInstanceRequest(value: unknown, expectedValue: AutomationInstanceRequestExpected,
  now = Date.now()): Promise<AutomationInstanceRequestPayload> {
  return verifyFreshDeviceRequest(value, expectedValue, payloadSchema, proofSchema, expectedSchema,
    ["action", "origin", "workspaceId", "definitionId", "integrationId", "executorPersonId", "bodyHash"], now,
    "Automation instance")
}
