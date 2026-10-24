import { z } from "zod"
import { verifyEnvelope } from "../domain/identityCrypto"
import { decodeBlindBytes, rustyHash } from "@meta-uber/mesh-replication/rusty-replica"

const policyId = z.string().min(1).max(128)
const policyHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const scopePolicyReceiptSchema = z.strictObject({
  signerKeyId: policyHash, signature: z.string().min(1).max(128),
  payload: z.strictObject({ kind: z.literal("rusty-scope-policy-receipt"), version: z.literal(1), serviceId: policyHash,
    scopeId: policyId, personId: policyId, revision: z.number().int().positive().refine(Number.isSafeInteger), revoked: z.boolean(),
    challengeId: policyId, authorizationHash: policyHash, minimumWriterVersion: z.literal(2).optional(),
    scopePurpose: z.enum(["workspace", "person-identity"]).optional() }),
})
export type RustyScopePolicyReceipt = z.infer<typeof scopePolicyReceiptSchema>
type RustyPolicyStorage = { scopeId: string; servicePublicKey: string }

/** Structural parsing is safe during a local transaction; callers verify cryptography before using saved evidence. */
export function parseRustyScopePolicyReceipt(value: unknown): RustyScopePolicyReceipt {
  return scopePolicyReceiptSchema.parse(structuredClone(value))
}

/** A service receipt confirms only storage policy. Current Owner requests separately authorize maintenance. */
export async function verifyRustyWriterPolicyReceipt(value: unknown, storageValue: RustyPolicyStorage,
  personId: string, minimumRevision: number): Promise<RustyScopePolicyReceipt> {
  const receipt = parseRustyScopePolicyReceipt(value)
  const storage = structuredClone(storageValue)
  const payload = receipt.payload
  const key = decodeBlindBytes(storage.servicePublicKey)
  if (key.length !== 32 || !Number.isSafeInteger(minimumRevision) || minimumRevision < 0 ||
    payload.scopeId !== storage.scopeId || payload.personId !== personId || payload.revoked ||
    payload.minimumWriterVersion !== 2 || payload.revision < minimumRevision ||
    receipt.signerKeyId !== payload.serviceId || payload.serviceId !== await rustyHash(key) ||
    !await verifyEnvelope(receipt, storage.servicePublicKey, "RUSTY/2")) throw new Error("Rusty receipt does not confirm this writer policy")
  return receipt
}
