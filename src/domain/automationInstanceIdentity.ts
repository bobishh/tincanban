import { z } from "zod"
import { canonicalizeJson, type SignedEnvelope } from "./identity"
import { isAutomationOrigin } from "./automationLifecycle"
import { parseAutomationInstanceDescription, type AutomationInstanceDescription } from "./automationInstanceData"
import { publicDeviceProofFields, verifyDeviceProofSignature } from "./deviceProof"
import { signWithContext, signingEvidence, type VerifiedSigningContext } from "./signingContext"
import type { DeviceCertificate } from "./model"

const MAX_AUTOMATION_INSTANCE_IDENTITY_BYTES = 128 * 1024
const identifier = z.string().min(1).max(256).refine(value => Boolean(value.trim()))
const routeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const identityFields = {
  origin: z.string().refine(isAutomationOrigin),
  workspaceId: identifier,
  definitionId: routeId,
  integrationId: routeId,
}
const inputSchema = z.strictObject({ ...identityFields, requestNonce: z.string().uuid(), description: z.unknown() })
const payloadSchema = z.strictObject({
  kind: z.literal("automation-instance-identity"),
  version: z.literal(1),
  ...identityFields,
  executorPersonId: identifier,
  deviceId: identifier,
  requestNonce: z.string().uuid(),
  issuedAt: z.number().int().positive().refine(Number.isSafeInteger),
  description: z.unknown(),
})
const signedSchema = z.strictObject({
  signerKeyId: identifier,
  signature: z.string().min(1).max(128),
  payload: payloadSchema,
})
const proofSchema = z.strictObject({ ...publicDeviceProofFields, signed: signedSchema })
const expectedSchema = z.strictObject({ ...identityFields, executorPersonId: identifier, requestNonce: z.string().uuid() })

export type AutomationInstanceIdentityInput = z.input<typeof inputSchema> & { description: AutomationInstanceDescription }
export type AutomationInstanceIdentityPayload = z.output<typeof payloadSchema> & { description: AutomationInstanceDescription }
export type AutomationInstanceIdentityProof = {
  publicKey: string
  certificates: DeviceCertificate[]
  signed: SignedEnvelope<AutomationInstanceIdentityPayload>
}
export type AutomationInstanceIdentityExpected = z.input<typeof expectedSchema>

/** Sign a bounded management identity snapshot under the live owner signing context. */
export async function createAutomationInstanceIdentity(context: VerifiedSigningContext,
  inputValue: AutomationInstanceIdentityInput): Promise<AutomationInstanceIdentityProof> {
  const input = parseInput(inputValue)
  assertDescriptionMatches(input.description, input.workspaceId, input.definitionId, context.personId)
  const payload = parsePayload({ ...input, kind: "automation-instance-identity", version: 1,
    executorPersonId: context.personId, deviceId: context.deviceId, issuedAt: Date.now() })
  const evidence = signingEvidence(context)
  const signed = await signWithContext(context, payload)
  return parseProof({ publicKey: evidence.identity.publicKey, certificates: evidence.certificates, signed })
}

/** Verify the exact management response, nonce, freshness and complete pinned-device chain. */
export async function verifyAutomationInstanceIdentity(value: unknown,
  expectedValue: AutomationInstanceIdentityExpected, now = Date.now()): Promise<AutomationInstanceIdentityPayload> {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid automation identity verification time")
  const proof = parseProof(value)
  const expected = expectedSchema.parse(capture(expectedValue))
  const payload = proof.signed.payload
  for (const key of ["origin", "workspaceId", "definitionId", "integrationId", "executorPersonId", "requestNonce"] as const) {
    if (payload[key] !== expected[key]) throw new Error(`Automation instance identity ${key} does not match request`)
  }
  if (payload.issuedAt > now + 5_000 || now - payload.issuedAt > 60_000) {
    throw new Error("Automation instance identity proof is outside its freshness window")
  }
  assertDescriptionMatches(payload.description, payload.workspaceId, payload.definitionId, payload.executorPersonId)
  await verifyDeviceProofSignature(proof, payload.executorPersonId, payload.deviceId)
  return payload
}

function parseInput(value: unknown): Omit<AutomationInstanceIdentityInput, "description"> & { description: AutomationInstanceDescription } {
  const parsed = inputSchema.parse(capture(value))
  return { ...parsed, description: parseAutomationInstanceDescription(parsed.description) }
}

function parsePayload(value: unknown): AutomationInstanceIdentityPayload {
  const parsed = payloadSchema.parse(capture(value))
  return { ...parsed, description: parseAutomationInstanceDescription(parsed.description) }
}

function assertDescriptionMatches(description: AutomationInstanceDescription, workspaceId: string,
  definitionId: string, executorPersonId: string): void {
  if (description.workspaceId !== workspaceId || description.executorPersonId !== executorPersonId ||
      (description.definitionId !== definitionId && !(description.definitionId === null && description.adoptionRequired))) {
    throw new Error("Automation instance identity description does not match request scope")
  }
}

function parseProof(value: unknown): AutomationInstanceIdentityProof {
  const snapshot = capture(value)
  const encoded = canonicalizeJson(snapshot)
  if (new TextEncoder().encode(encoded).byteLength > MAX_AUTOMATION_INSTANCE_IDENTITY_BYTES) {
    throw new TypeError("Automation instance identity proof exceeds the size limit")
  }
  const parsed = proofSchema.parse(snapshot)
  const payload = parsePayload(parsed.signed.payload)
  return { ...parsed, signed: { ...parsed.signed, payload } } as AutomationInstanceIdentityProof
}

function capture(value: unknown): unknown {
  let snapshot: unknown
  try { snapshot = structuredClone(value) }
  catch { throw new TypeError("Automation instance identity is not cloneable JSON") }
  try { canonicalizeJson(snapshot) }
  catch { throw new TypeError("Automation instance identity is not canonical JSON data") }
  return snapshot
}
