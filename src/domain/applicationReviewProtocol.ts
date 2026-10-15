import { z } from "zod"
import type { SignedEnvelope } from "./identity"
import { isAutomationOrigin } from "./automationLifecycle"
import type { VerifiedSigningContext } from "./signingContext"
import type { DeviceCertificate } from "./model"
import { createFreshDeviceRequest, freshDeviceRequestFields, freshDeviceRequestMetadata, verifyFreshDeviceRequest } from "./freshDeviceRequest"
import { publicDeviceProofFields } from "./deviceProof"

const identifier = z.string().min(1).max(256).refine(value => Boolean(value.trim()))
const integrationId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const inputSchema = z.strictObject({
  action: z.enum(["discover", "list", "review", "bind", "retry", "retry-unbound"]),
  origin: z.string().refine(isAutomationOrigin),
  workspaceId: identifier,
  definitionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  integrationId: integrationId.nullable(),
  bodyHash: hash,
}).refine(value => value.action === "discover" || value.integrationId !== null,
  { message: "Only discovery requests may omit the integration ID" })
const payloadSchema = z.strictObject({
  kind: z.literal("automation-application-review-request"),
  version: z.literal(1),
  ...inputSchema.shape,
  ...freshDeviceRequestFields,
})
const proofSchema = z.strictObject({ ...publicDeviceProofFields,
  signed: z.strictObject({ signerKeyId: identifier, signature: z.string().min(1).max(128), payload: payloadSchema }) })
const expectedSchema = z.strictObject({
  action: inputSchema.shape.action,
  origin: inputSchema.shape.origin,
  workspaceId: identifier,
  definitionId: inputSchema.shape.definitionId,
  integrationId: integrationId.nullable(),
  bodyHash: hash,
}).refine(value => value.action === "discover" || value.integrationId !== null,
  { message: "Only discovery requests may omit the integration ID" })

export type ApplicationReviewRequestInput = z.input<typeof inputSchema>
export type ApplicationReviewRequestPayload = z.output<typeof payloadSchema>
export type ApplicationReviewRequestProof = {
  publicKey: string
  certificates: DeviceCertificate[]
  signed: SignedEnvelope<ApplicationReviewRequestPayload>
}
export type ApplicationReviewRequestExpected = z.input<typeof expectedSchema>

/** Create a nonce-bearing review request under a live owner signing context. */
export async function createApplicationReviewRequest(context: VerifiedSigningContext,
  inputValue: ApplicationReviewRequestInput): Promise<ApplicationReviewRequestProof> {
  const input = inputSchema.parse(structuredClone(inputValue))
  const now = Date.now()
  const payload = { ...input, kind: "automation-application-review-request", version: 1,
    ...freshDeviceRequestMetadata(context, now) }
  return createFreshDeviceRequest(context, payload, payloadSchema, proofSchema, "Application review") as
    Promise<ApplicationReviewRequestProof>
}

/** Verify exact request binding, freshness, root identity and complete device proof. */
export async function verifyApplicationReviewRequest(value: unknown, expectedValue: ApplicationReviewRequestExpected,
  now = Date.now()): Promise<ApplicationReviewRequestPayload> {
  return verifyFreshDeviceRequest(value, expectedValue, payloadSchema, proofSchema, expectedSchema,
    ["action", "origin", "workspaceId", "definitionId", "integrationId", "bodyHash"], now,
    "Application review")
}
