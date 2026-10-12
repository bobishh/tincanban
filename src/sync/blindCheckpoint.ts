import { signEnvelope, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import type { DeviceCertificate, PublicIdentity } from "../domain/model"
import { rustyCertificateChain } from "./rustyEnrollment"
import { blindHash, blindObjectId, blindProducerHeaders, blindOrigin, canonicalBlindJson, fetchBlind, readBlindJson, type BlindAccess } from "./blindClient"
import { decodeBlindBytes, type BlindObject } from "./blindEnvelope"

type CheckpointAuthorization = { kind: "rusty-snapshot-checkpoint"; version: 1; serviceId: string; origin: string; scopeId: string;
  keyEpoch: number; policyRevision: number; expectedSequence: number; objectId: string; requestId: string; issuedAt: number; expiresAt: number }
export type BlindCheckpointRequest = { object: BlindObject; identity: PublicIdentity; deviceId: string; certificates: DeviceCertificate[];
  authorization: SignedEnvelope<CheckpointAuthorization> }
export type BlindCheckpointReceipt = SignedEnvelope<{ kind: "rusty-snapshot-checkpoint-receipt"; version: 1; serviceId: string;
  scopeId: string; keyEpoch: number; objectId: string; sequence: number; supersedesThrough: number; policyRevision: number;
  requestId: string; authorizationHash: string }>

/** Prepared evidence stays immutable across uncertain transport retries. Content keys never leave this device. */
export async function prepareBlindCheckpoint(access: BlindAccess, object: BlindObject, expectedSequence: number, profile: LocalProfile): Promise<BlindCheckpointRequest> {
  const issuedAt = Date.now()
  const payload: CheckpointAuthorization = { kind: "rusty-snapshot-checkpoint", version: 1,
    serviceId: await blindHash(decodeBlindBytes(access.servicePublicKey)), origin: blindOrigin(access.origin), scopeId: access.scopeId,
    keyEpoch: object.keyEpoch, policyRevision: access.policyRevision, expectedSequence, objectId: await blindObjectId(object),
    requestId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + 120000 }
  return { object, identity: profile.identity, deviceId: profile.device.deviceId, certificates: await rustyCertificateChain(profile),
    authorization: await signEnvelope(profile.privateKeys.devicePrivateKey, payload, profile.device.deviceId) }
}

export async function verifyCheckpointReceipt(receipt: BlindCheckpointReceipt, access: BlindAccess, request: BlindCheckpointRequest): Promise<void> {
  const expected = request.authorization.payload
  const payload = receipt.payload
  const pinnedServiceId = await blindHash(decodeBlindBytes(access.servicePublicKey))
  const authorizationHash = await blindHash(new TextEncoder().encode(canonicalBlindJson(request.authorization)))
  if (!payload || payload.kind !== "rusty-snapshot-checkpoint-receipt" || payload.version !== 1 ||
    receipt.signerKeyId !== pinnedServiceId || expected.serviceId !== pinnedServiceId ||
    expected.objectId !== await blindObjectId(request.object) || !checkpointBindingMatches(payload, access, expected) ||
    payload.authorizationHash !== authorizationHash) throw new Error("Rusty checkpoint receipt does not cover this replacement")
  if (!await verifyEnvelope(receipt, access.servicePublicKey, "RUSTY/2")) throw new Error("Rusty checkpoint receipt signature invalid")
}

function checkpointBindingMatches(payload: BlindCheckpointReceipt["payload"], access: BlindAccess, expected: CheckpointAuthorization): boolean {
  return payload.serviceId === expected.serviceId && payload.scopeId === access.scopeId && payload.keyEpoch === expected.keyEpoch &&
    payload.objectId === expected.objectId && payload.requestId === expected.requestId && payload.policyRevision === access.policyRevision &&
    payload.supersedesThrough === expected.expectedSequence && payload.sequence === expected.expectedSequence + 1 && Number.isSafeInteger(payload.sequence)
}

export async function submitBlindCheckpoint(access: BlindAccess, request: BlindCheckpointRequest): Promise<BlindCheckpointReceipt> {
  const receipt = await readBlindJson<BlindCheckpointReceipt>(await fetchBlind(`${blindOrigin(access.origin)}/v2/scopes/${access.scopeId}/checkpoint`, {
    method: "POST", signal: AbortSignal.timeout(30000), headers: { ...blindProducerHeaders(access), Authorization: `Bearer ${access.writeToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }), 16384)
  await verifyCheckpointReceipt(receipt, access, request)
  return receipt
}
