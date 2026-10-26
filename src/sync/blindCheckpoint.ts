import { verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { signingEvidence, signWithContext } from "../domain/signingContext"
import type { DeviceCertificate, PublicIdentity } from "../domain/model"
import { blindHash, blindObjectId, blindProducerHeaders, canonicalBlindJson, discoverBlindKeeper, type BlindAccess } from "./blindClient"
import { fetchBlind, readBlindJson } from "./rustyHttp"
import type { RustyFetch } from "@meta-uber/mesh-replication/rusty-replica"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { decodeBlindBytes, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { rustyManagementAuthorityRevision, type ManagementClientGuard } from "./rustyManagementClient"
import { verifyRustyManagementCapability, type RustyManagementCapability } from "./rustyManagementCapability"

type CheckpointAuthorization = { kind: "rusty-snapshot-checkpoint"; version: 1; serviceId: string; origin: string; scopeId: string;
  keyEpoch: number; policyRevision: number; expectedSequence: number; objectId: string; requestId: string; issuedAt: number; expiresAt: number;
  managementRevision?: number; writerVersion?: 2 }
export type BlindCheckpointRequest = { object: BlindObject; identity: PublicIdentity; deviceId: string; certificates: DeviceCertificate[];
  authorization: SignedEnvelope<CheckpointAuthorization>; managementCapability?: SignedEnvelope<RustyManagementCapability> }
export type BlindCheckpointReceipt = SignedEnvelope<{ kind: "rusty-snapshot-checkpoint-receipt"; version: 1; serviceId: string;
  scopeId: string; keyEpoch: number; objectId: string; sequence: number; supersedesThrough: number; policyRevision: number;
  requestId: string; authorizationHash: string }>

/** Prepared evidence stays immutable across uncertain transport retries. Content keys never leave this device. */
export async function prepareBlindCheckpoint(access: BlindAccess, object: BlindObject, expectedSequence: number, profile: LocalProfile,
  guard: ManagementClientGuard = {}): Promise<BlindCheckpointRequest> {
  access = { ...access }
  object = structuredClone(object)
  profile = structuredClone(profile)
  const service = await discoverBlindKeeper(access.origin)
  if (service.servicePublicKey !== access.servicePublicKey) throw new Error("Rusty checkpoint service pin changed")
  const writerVersion = service.writerPolicy?.maximumWriterVersion === 2 ? 2 as const : undefined
  const binding = { origin: blindOrigin(access.origin), servicePublicKey: access.servicePublicKey, resourceKind: "scope" as const, resourceId: access.scopeId }
  const managementCapability = (await new RustyManagementRepository(profile.identity.personId).read(binding))?.capability
  const managementRevision = rustyManagementAuthorityRevision(binding, profile, "snapshot.checkpoint", managementCapability)
  const issuedAt = Date.now()
  const context = await resolveLocalSigningContext(profile, "rusty-snapshot-checkpoint", {
    origin: blindOrigin(access.origin), scopeId: access.scopeId,
    ...(writerVersion === undefined ? {} : { writerVersion }),
  }, { expiresAt: issuedAt + 120000, ensureCurrent: guard.ensureCurrent,
    currentAuthority: async () => `${await managementRevision()}/${await guard.currentAuthority?.() ?? ""}` })
  const payload: CheckpointAuthorization = { kind: "rusty-snapshot-checkpoint", version: 1,
    serviceId: await blindHash(decodeBlindBytes(access.servicePublicKey)), origin: blindOrigin(access.origin), scopeId: access.scopeId,
    keyEpoch: object.keyEpoch, policyRevision: access.policyRevision, expectedSequence, objectId: await blindObjectId(object),
    requestId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + 120000,
    ...(writerVersion === undefined ? {} : { writerVersion }),
    ...(managementCapability ? { managementRevision: managementCapability.payload.revision } : {}) }
  return { object, identity: signingEvidence(context).identity, deviceId: context.deviceId, certificates: signingEvidence(context).certificates,
    authorization: await signWithContext(context, payload), ...(managementCapability ? { managementCapability } : {}) }
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

export async function submitBlindCheckpoint(access: BlindAccess, request: BlindCheckpointRequest, fetcher: RustyFetch = fetchBlind): Promise<BlindCheckpointReceipt> {
  access = { ...access }
  request = structuredClone(request)
  const binding = { origin: blindOrigin(access.origin), servicePublicKey: access.servicePublicKey, resourceKind: "scope" as const, resourceId: access.scopeId }
  await rustyManagementAuthorityRevision(binding, { identity: request.identity, device: { deviceId: request.deviceId } },
    "snapshot.checkpoint", request.managementCapability)()
  if (request.managementCapability) {
    const cap = await verifyRustyManagementCapability(request.managementCapability, binding, { personId: request.identity.personId,
      deviceId: request.deviceId, resourceKind: "scope", resourceId: access.scopeId, operation: "snapshot.checkpoint", minimumRevision: 1 })
    if (request.authorization.payload.managementRevision !== cap.revision) throw new Error("Checkpoint management revision is stale")
  }
  const receipt = await readBlindJson<BlindCheckpointReceipt>(await fetcher(`${blindOrigin(access.origin)}/v2/scopes/${access.scopeId}/checkpoint`, {
    method: "POST", signal: AbortSignal.timeout(30000), headers: { ...blindProducerHeaders(access), Authorization: `Bearer ${access.writeToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }), 16384)
  await verifyCheckpointReceipt(receipt, access, request)
  return receipt
}
