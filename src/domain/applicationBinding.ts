import { z } from "zod"
import { canonicalizeJson, type SignedEnvelope } from "./identityCrypto"
import { isAutomationOrigin } from "./automationLifecycle"
import { signWithContext, signingEvidence, type VerifiedSigningContext } from "./signingContext"
import type { DeviceCertificate } from "./model"
import { publicDeviceProofFields, verifyDeviceProofSignature } from "./deviceProof"

const MAX_PROOF_BYTES = 128 * 1024
const identifier = z.string().min(1).max(256).refine(value => Boolean(value.trim()))
const uuid = z.string().uuid()
const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const workflowSchema = z.strictObject({
  columnId: identifier,
  changedAt: z.string().min(1).max(64).refine(value => Number.isFinite(Date.parse(value))),
})
const applicationBindingInputSchema = z.strictObject({
  bindingId: uuid,
  previousBindingId: uuid.nullable(),
  origin: z.string().refine(isAutomationOrigin),
  integrationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  definitionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  workspaceId: identifier,
  cardId: identifier,
  grantId: identifier,
  eventId: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/),
  eventHash: hash,
  decisionHash: hash,
  sourceRecordId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  sourceHash: hash,
  accessEpoch: z.number().int().positive().refine(Number.isSafeInteger),
  workflow: workflowSchema,
})
const applicationBindingPayloadSchema = z.strictObject({
  kind: z.literal("automation-application-binding"),
  version: z.literal(1),
  ...applicationBindingInputSchema.shape,
  personId: identifier,
  deviceId: identifier,
  issuedAt: z.number().int().positive().refine(Number.isSafeInteger),
})
const signedSchema = z.strictObject({
  signerKeyId: identifier,
  signature: z.string().min(1).max(128),
  payload: applicationBindingPayloadSchema,
})
const proofSchema = z.strictObject({
  ...publicDeviceProofFields,
  signed: signedSchema,
})
const expectedSchema = z.strictObject({
  ownerPersonId: identifier,
  ...applicationBindingInputSchema.omit({ bindingId: true, previousBindingId: true }).shape,
})

export type ApplicationBindingInput = z.infer<typeof applicationBindingInputSchema>
export type ApplicationBindingPayload = z.infer<typeof applicationBindingPayloadSchema>
export type ApplicationBindingProof = {
  publicKey: string
  certificates: DeviceCertificate[]
  signed: SignedEnvelope<ApplicationBindingPayload>
}
export type ApplicationBindingExpected = z.infer<typeof expectedSchema>

/** Parse an exact public proof and enforce its canonical UTF-8 size bound. */
export function parseApplicationBindingProof(value: unknown): ApplicationBindingProof {
  let encoded: string
  try { encoded = canonicalizeJson(value) }
  catch { throw new TypeError("Application binding proof is not canonical JSON data") }
  if (new TextEncoder().encode(encoded).byteLength > MAX_PROOF_BYTES) {
    throw new TypeError("Application binding proof exceeds the size limit")
  }
  const parsed = proofSchema.parse(value)
  const certificateHashes = parsed.certificates.map(certificate => canonicalizeJson(certificate))
  if (new Set(certificateHashes).size !== certificateHashes.length) throw new TypeError("Application binding certificate chain contains duplicates")
  return parsed as ApplicationBindingProof
}

/** Create an owner-device proof bound to a live signing context. */
export async function createApplicationBinding(context: VerifiedSigningContext,
  input: ApplicationBindingInput): Promise<ApplicationBindingProof> {
  const snapshot = applicationBindingInputSchema.parse(structuredClone(input))
  const evidence = signingEvidence(context)
  const payload = applicationBindingPayloadSchema.parse({
    kind: "automation-application-binding",
    version: 1,
    ...snapshot,
    personId: context.personId,
    deviceId: context.deviceId,
    issuedAt: Date.now(),
  })
  const signed = await signWithContext(context, payload)
  return parseApplicationBindingProof({ publicKey: evidence.identity.publicKey, certificates: evidence.certificates, signed })
}

/** Verify historical proof integrity and exact expected binding; caller enforces current authority. */
export async function verifyApplicationBinding(value: unknown,
  expectedValue: ApplicationBindingExpected): Promise<ApplicationBindingPayload> {
  const proof = parseApplicationBindingProof(value)
  const expected = expectedSchema.parse(structuredClone(expectedValue))
  const payload = proof.signed.payload
  for (const key of ["origin", "integrationId", "definitionId", "workspaceId", "cardId", "grantId", "eventId", "eventHash",
    "decisionHash", "sourceRecordId", "sourceHash", "accessEpoch"] as const) {
    if (payload[key] !== expected[key]) throw new Error(`Application binding ${key} does not match expected scope`)
  }
  if (payload.personId !== expected.ownerPersonId || canonicalizeJson(payload.workflow) !== canonicalizeJson(expected.workflow)) {
    throw new Error("Application binding owner or workflow does not match expected scope")
  }
  await verifyDeviceProofSignature(proof, expected.ownerPersonId, payload.deviceId)
  return payload
}
