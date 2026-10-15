import { z } from "zod"
import { canonicalizeJson, type SignedEnvelope } from "./identity"
import { verifyDeviceProofSignature } from "./deviceProof"
import type { publicDeviceProofFields } from "./deviceProof"
import { signWithContext, signingEvidence, type VerifiedSigningContext } from "./signingContext"

const MAX_PROOF_BYTES = 128 * 1024
const identifier = z.string().min(1).max(256).refine(value => Boolean(value.trim()))
const safePositiveInteger = z.number().int().positive().refine(Number.isSafeInteger)

/** Shared strict signer and lifetime fields for short-lived device requests. */
export const freshDeviceRequestFields = {
  personId: identifier,
  deviceId: identifier,
  nonce: z.string().uuid(),
  issuedAt: safePositiveInteger,
  expiresAt: safePositiveInteger,
}

export type FreshDeviceRequestPayload = {
  kind: string
  personId: string
  deviceId: string
  issuedAt: number
  expiresAt: number
}

export type FreshDeviceRequestProof<T extends FreshDeviceRequestPayload> = {
  publicKey: string
  certificates: z.infer<typeof publicDeviceProofFields.certificates>[number][]
  signed: SignedEnvelope<T>
}

/** Capture validated request data and sign it with the context's full verified device chain. */
export async function createFreshDeviceRequest<T extends FreshDeviceRequestPayload>(
  context: VerifiedSigningContext,
  payloadValue: unknown,
  payloadSchema: z.ZodType<T>,
  proofSchema: z.ZodType<unknown>,
  label: string,
): Promise<FreshDeviceRequestProof<T>> {
  const payload = payloadSchema.parse(captureFreshDeviceJson(payloadValue, label))
  const evidence = signingEvidence(context)
  const signed = await signWithContext(context, payload)
  return parseFreshDeviceProof({ publicKey: evidence.identity.publicKey, certificates: evidence.certificates, signed },
    payloadSchema, proofSchema, label) as FreshDeviceRequestProof<T>
}

/** Verify captured exact request coordinates, freshness, pinned identity, and complete certificate chain. */
export async function verifyFreshDeviceRequest<T extends FreshDeviceRequestPayload>(
  proofValue: unknown,
  expectedValue: unknown,
  payloadSchema: z.ZodType<T>,
  proofSchema: z.ZodType<unknown>,
  expectedSchema: z.ZodType<Record<string, unknown>>,
  coordinates: readonly (keyof T & string)[],
  now: number,
  label: string,
): Promise<T> {
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError(`Invalid ${label} verification time`)
  const proof = parseFreshDeviceProof(proofValue, payloadSchema, proofSchema, label) as FreshDeviceRequestProof<T>
  const expected = expectedSchema.parse(captureFreshDeviceJson(expectedValue, `${label} expected scope`))
  const payload = proof.signed.payload
  for (const key of coordinates) {
    if (payload[key] !== expected[key]) throw new Error(`${label} request ${key} does not match expected scope`)
  }
  if (payload.issuedAt > now + 5_000 || payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt > 60_000) {
    throw new Error(`${label} request is expired or outside its allowed lifetime`)
  }
  await verifyDeviceProofSignature(proof, payload.personId, payload.deviceId)
  return payload
}

/** Clone first, then canonicalize and bound the detached JSON proof before schema or crypto work. */
function parseFreshDeviceProof<T extends FreshDeviceRequestPayload>(
  value: unknown,
  payloadSchema: z.ZodType<T>,
  proofSchema: z.ZodType<unknown>,
  label: string,
): FreshDeviceRequestProof<T> {
  const snapshot = captureFreshDeviceJson(value, `${label} proof`)
  let encoded: string
  try { encoded = canonicalizeJson(snapshot) }
  catch { throw new TypeError(`${label} proof is not canonical JSON data`) }
  if (new TextEncoder().encode(encoded).byteLength > MAX_PROOF_BYTES) {
    throw new TypeError(`${label} proof exceeds the size limit`)
  }
  const parsed = proofSchema.parse(snapshot) as {
    publicKey: string
    certificates: FreshDeviceRequestProof<T>["certificates"]
    signed: { payload: unknown }
  }
  const payload = payloadSchema.parse(parsed.signed.payload)
  return { ...parsed, signed: { ...parsed.signed, payload } } as FreshDeviceRequestProof<T>
}

/** Make shared signer fields before any async signing operation begins. */
export function freshDeviceRequestMetadata(context: VerifiedSigningContext, now = Date.now()) {
  return {
    personId: context.personId,
    deviceId: context.deviceId,
    nonce: crypto.randomUUID(),
    issuedAt: now,
    expiresAt: now + 60_000,
  }
}

export function captureFreshDeviceJson(value: unknown, label: string): unknown {
  try { return structuredClone(value) }
  catch { throw new TypeError(`${label} is not cloneable JSON`) }
}
