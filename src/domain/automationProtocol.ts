import { z } from "zod"
import { canonicalizeJson, publicKeyId, sha256Base64Url, signEnvelope, verifyEnvelope, type LocalProfile } from "./identity"
import { certHashDefault, validateCertificateChain } from "./proofs"
import type { DeviceCertificate } from "./model"
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
export type AutomationOwnerPayload = z.infer<typeof ownerPayload>
export type AutomationObservation = z.infer<typeof observationPayload>

export async function automationBodyHash(value: unknown): Promise<string> {
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(value)))
}

export async function createAutomationOwnerRequest(profile: LocalProfile,
  input: Pick<AutomationOwnerPayload, "action" | "origin" | "workspaceId" | "integrationId" | "bodyHash">, certificatePool: readonly DeviceCertificate[] = []) {
  const now = Date.now()
  const payload = ownerPayload.parse({ ...input, kind: "automation-owner-request", version: 1,
    personId: profile.identity.personId, nonce: crypto.randomUUID(), issuedAt: now, expiresAt: now + 60_000 })
  const certificates = await ownerCertificateChain(profile.certificate, certificatePool)
  return { publicKey: profile.identity.publicKey, certificates,
    signed: await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId) }
}

async function ownerCertificateChain(leaf: DeviceCertificate, pool: readonly DeviceCertificate[]): Promise<DeviceCertificate[]> {
  const byHash = new Map(await Promise.all(pool.map(async certificate => [await certHashDefault(certificate), certificate] as const)))
  const chain: DeviceCertificate[] = []
  const visited = new Set<string>()
  let current = leaf
  for (;;) {
    const hash = await certHashDefault(current)
    if (visited.has(hash) || chain.length >= 32) throw new Error("Device certificate chain is invalid")
    visited.add(hash)
    chain.push(current)
    if (current.payload.issuerCertificateHash === null) return chain
    const issuer = byHash.get(current.payload.issuerCertificateHash)
    if (!issuer) throw new Error("Device trust chain is incomplete. Reconnect this device before adding automation.")
    current = issuer
  }
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
  const envelope = proof.parse(value)
  const payload = observationPayload.parse(envelope.signed.payload)
  if (payload.origin !== expected.origin || payload.integrationId !== expected.integrationId ||
    payload.workspaceId !== expected.workspaceId || payload.grantId !== expected.grantId || payload.nonce !== expected.nonce ||
    payload.issuedAt > now + 5_000 || payload.issuedAt < now - 60_000 || new Set(payload.heads).size !== payload.heads.length) {
    throw new Error("Worker observation does not match the requested automation")
  }
  await verifyDeviceProof(envelope, expected.personId)
  return payload
}
