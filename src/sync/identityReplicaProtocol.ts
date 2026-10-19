import { z } from "zod"
import { verifyDeviceCertificateChain } from "@meta-uber/mesh-identity"
import { sha256Base64Url, verifyEnvelope, type SignedEnvelope } from "../domain/identity"
import { signingEvidence, signWithContext, type VerifiedSigningContext } from "../domain/signingContext"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { publicIdentitySchema, deviceCertificateSchema } from "./identityDeviceTransferSchemas"
import { readIdentityDeviceTransfer } from "./identityDeviceTransferReader"
import type { IdentityDeviceState } from "./identityDeviceStateCodec"

export type IdentityReplicaBinding = { personId: string; origin: string; scopeId: string; keyEpoch: number; servicePublicKey: string }
type Payload = { kind: "identity-replica-state"; version: 1; personId: string; origin: string; serviceId: string; scopeId: string;
  keyEpoch: number; managementRevision: number; deviceId: string; identity: z.infer<typeof publicIdentitySchema>;
  certificates: z.infer<typeof deviceCertificateSchema>[]; state: IdentityDeviceState }
export type IdentityReplicaRecord = SignedEnvelope<Payload>
const text = z.string().min(1).max(512)
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const schema = z.object({ payload: z.object({ kind: z.literal("identity-replica-state"), version: z.literal(1),
  personId: text, origin: text, serviceId: text, scopeId: text, keyEpoch: positive, managementRevision: positive, deviceId: text,
  identity: publicIdentitySchema, certificates: z.array(deviceCertificateSchema).min(1).max(32), state: z.unknown(),
}).strict(), signerKeyId: text, signature: text }).strict()
const maximumBytes = 2 * 1024 * 1024

async function serviceId(binding: IdentityReplicaBinding): Promise<string> {
  if (blindOrigin(binding.origin) !== binding.origin || !/^[A-Za-z0-9_-]{1,128}$/.test(binding.scopeId) ||
    !Number.isSafeInteger(binding.keyEpoch) || binding.keyEpoch < 1) throw new Error("Invalid private identity scope binding")
  const key = decodeBlindBytes(binding.servicePublicKey)
  if (key.length !== 32) throw new Error("Invalid private identity service binding")
  return sha256Base64Url(key)
}

/** A storage token is not author evidence. Every private manifest retains its same-person device signature. */
export async function createIdentityReplicaRecord(context: VerifiedSigningContext, binding: IdentityReplicaBinding,
  state: IdentityDeviceState, managementRevision: number): Promise<IdentityReplicaRecord> {
  binding = structuredClone(binding)
  state = structuredClone(state)
  const evidence = signingEvidence(context)
  if (context.personId !== binding.personId || state.personId !== binding.personId) throw new Error("Private identity binding mismatch")
  if (!Number.isSafeInteger(managementRevision) || managementRevision < 1) throw new Error("Confirmed private identity management authority required")
  await readIdentityDeviceTransfer(state, binding.personId)
  const payload: Payload = { kind: "identity-replica-state", version: 1, personId: binding.personId, origin: binding.origin,
    serviceId: await serviceId(binding), scopeId: binding.scopeId, keyEpoch: binding.keyEpoch, managementRevision,
    deviceId: context.deviceId, identity: evidence.identity, certificates: evidence.certificates, state }
  const record = await signWithContext(context, payload)
  schema.parse(record)
  if (new TextEncoder().encode(JSON.stringify(record)).length > maximumBytes) throw new Error("Private identity replica exceeds byte limit")
  return record
}

/** Caller supplies current person-scope authority, checked around full asynchronous preflight. No storage writes occur here. */
export async function readIdentityReplicaRecord(value: unknown, expected: IdentityReplicaBinding,
  authorize: (deviceId: string, managementRevision: number) => Promise<void>) {
  value = structuredClone(value)
  expected = structuredClone(expected)
  if (new TextEncoder().encode(JSON.stringify(value)).length > maximumBytes) throw new Error("Private identity replica exceeds byte limit")
  const parsed = schema.parse(value)
  const payload = parsed.payload
  if (payload.personId !== expected.personId || payload.identity.personId !== expected.personId ||
    payload.scopeId !== expected.scopeId || payload.keyEpoch !== expected.keyEpoch || payload.origin !== expected.origin ||
    payload.serviceId !== await serviceId(expected) || parsed.signerKeyId !== payload.deviceId) {
    throw new Error("Private identity replica binding mismatch")
  }
  const key = await verifyDeviceCertificateChain(payload.identity, payload.deviceId, payload.certificates, "MATCH/1")
  if (!await verifyEnvelope(parsed, key)) throw new Error("Invalid private identity replica signature")
  await authorize(payload.deviceId, payload.managementRevision)
  const transfer = await readIdentityDeviceTransfer(payload.state, expected.personId)
  await authorize(payload.deviceId, payload.managementRevision)
  return { record: parsed as IdentityReplicaRecord, transfer }
}
