import { z } from "zod"
import { canonicalizeJson, publicKeyId, sha256Base64Url, verifyEnvelope, type SignedEnvelope } from "./identityCrypto"
import { validateCertificateChain } from "./proofValidation"
import { signingEvidence, signWithContext, type VerifiedSigningContext } from "./signingContext"
import type { DeviceCertificate } from "./model"
import { publicDeviceProofFields, verifyDeviceProofSignature } from "./deviceProof"
import { isAutomationOrigin } from "./automationLifecycle"

const identifier = z.string().min(1).max(256)
const ownerPayload = z.strictObject({
  kind: z.literal("automation-owner-request"), version: z.literal(1),
  action: z.enum(["enroll", "activate", "observe", "email"]),
  origin: z.string().refine(isAutomationOrigin), integrationId: z.string().uuid(), workspaceId: identifier,
  personId: identifier, nonce: z.string().uuid(), issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive(),
  bodyHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/).nullable(),
})
const observationPayload = z.strictObject({
  kind: z.literal("automation-observation"), version: z.literal(1),
  origin: z.string().refine(isAutomationOrigin), integrationId: identifier, workspaceId: identifier, grantId: identifier,
  nonce: z.string().uuid(), issuedAt: z.number().int().positive(), state: z.enum(["active", "paused", "deleted"]),
  heads: z.array(z.string().uuid()).min(1).max(128),
})
const proof = z.object({ publicKey: z.string().max(128), certificates: z.array(z.unknown()).min(1).max(32),
  signed: z.object({ signerKeyId: identifier, signature: z.string().max(128), payload: z.object({ kind: z.string() }).passthrough() }) })
type AutomationOwnerPayload = z.infer<typeof ownerPayload>
export type AutomationOwnerRequestInput = Pick<AutomationOwnerPayload, "action" | "origin" | "workspaceId" | "integrationId" | "bodyHash">
export type AutomationObservation = z.infer<typeof observationPayload>
export type AutomationObservationProof = { publicKey: string; certificates: DeviceCertificate[]; signed: SignedEnvelope<AutomationObservation> }
const observationProofSchema = z.strictObject({ ...publicDeviceProofFields,
  signed: z.strictObject({ signerKeyId: identifier, signature: z.string().min(1).max(128), payload: observationPayload }) })

/** Detach bounded, exact observation evidence before any asynchronous verification. */
export function parseAutomationObservationProof(value: unknown): AutomationObservationProof {
  const captured: unknown = structuredClone(value)
  if (new TextEncoder().encode(canonicalizeJson(captured)).byteLength > 128 * 1024) throw new Error("Worker observation exceeds the size limit")
  return observationProofSchema.parse(captured) as AutomationObservationProof
}

export async function automationBodyHash(value: unknown): Promise<string> {
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
}

export async function createAutomationOwnerRequest(context: VerifiedSigningContext, input: AutomationOwnerRequestInput) {
  const now = Date.now()
  const payload = ownerPayload.parse({ ...input, kind: "automation-owner-request", version: 1,
    personId: context.personId, nonce: crypto.randomUUID(), issuedAt: now, expiresAt: now + 60_000 })
  const { identity, certificates } = signingEvidence(context)
  return { publicKey: identity.publicKey, certificates, signed: await signWithContext(context, payload) }
}

export async function verifyAutomationOwnerRequest(value: unknown, origin: string, owners: readonly string[], now = Date.now()) {
  const envelope = proof.parse(value)
  const payload = ownerPayload.parse(envelope.signed.payload)
  if (payload.origin !== origin || !owners.includes(payload.personId) || payload.issuedAt > now + 5_000 ||
    payload.expiresAt <= now || payload.expiresAt - payload.issuedAt > 60_000 || payload.expiresAt <= payload.issuedAt) {
    throw new Error("Owner request is unauthorized, expired or bound to another origin")
  }
  await verifyDeviceProof(envelope, payload.personId)
  return payload
}

async function verifyDeviceProof(envelope: z.infer<typeof proof>, personId: string): Promise<void> {
  if (await publicKeyId(envelope.publicKey) !== personId) throw new Error("Identity proof key is invalid")
  const certificates = envelope.certificates as DeviceCertificate[]
  const certificate = certificates.find(value => value?.payload?.deviceId === envelope.signed.signerKeyId)
  if (!certificate || certificate.payload.personId !== personId ||
    !(await validateCertificateChain(certificate, envelope.publicKey, certificates)).ok ||
    !(await verifyEnvelope(envelope.signed, certificate.payload.devicePublicKey))) throw new Error("Identity proof signature is invalid")
}

export async function verifyAutomationObservation(value: unknown,
  expected: { personId: string; origin: string; integrationId: string; workspaceId: string; grantId: string; nonce: string }, now = Date.now()) {
  const envelope = parseAutomationObservationProof(value)
  const payload = observationPayload.parse(envelope.signed.payload)
  if (payload.origin !== expected.origin || payload.integrationId !== expected.integrationId ||
    payload.workspaceId !== expected.workspaceId || payload.grantId !== expected.grantId || payload.nonce !== expected.nonce ||
    payload.issuedAt > now + 5_000 || payload.issuedAt < now - 60_000 || new Set(payload.heads).size !== payload.heads.length) {
    throw new Error("Worker observation does not match the requested automation")
  }
  await verifyDeviceProofSignature(envelope, expected.personId, envelope.signed.signerKeyId)
  return payload
}
