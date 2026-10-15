import { bootstrapIdentity, canonicalizeJson, sha256Base64Url, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { signingEvidence, signWithContext } from "../domain/signingContext"
import { decodeBlindBytes } from "./blindEnvelope"
import { fetchBlind, readBlindJson } from "./blindClient"
import { verifyRustyManagementCapability, verifyRustyManagementEvidence, type RustyManagementCapability } from "./rustyManagementCapability"
import { verifyRustyManagementStatus, type ManagementStatusAuthorization, type RustyManagementStatusResponse } from "./rustyManagementStatus"
import { RustyManagementRepository, validatePolicy, type ManagementBinding, type ManagementUpdateAuthorization, type ManagementUpdateRequest } from "./rustyManagementRepository"

export type ManagementClientGuard = { ensureCurrent?: () => void | Promise<void>; currentAuthority?: () => Promise<string> }
const encoder = new TextEncoder()
const path = (binding: ManagementBinding) => `${binding.origin}/v2/management/${binding.resourceKind}/${binding.resourceId}`
const repo = (profile: { identity: { personId: string } }) => new RustyManagementRepository(profile.identity.personId)
const revision = async (binding: ManagementBinding, profile: LocalProfile) => (await repo(profile).read(binding))?.capability?.payload.revision ?? 0

/** A signing guard observes both imported revocations and a newly started policy transition. */
export function rustyManagementAuthorityRevision(binding: ManagementBinding,
  profile: { identity: { personId: string }; device: { deviceId: string } }, operation: string,
  capability?: SignedEnvelope<RustyManagementCapability>): () => Promise<string> {
  binding = structuredClone(binding)
  profile = structuredClone(profile)
  capability = structuredClone(capability)
  return async () => {
    const saved = await repo(profile).read(binding)
    if (saved?.pending || canonicalizeJson(saved?.capability ?? null) !== canonicalizeJson(capability ?? null)) {
      throw new Error("Rusty management authority is stale or pending")
    }
    if (capability) await verifyRustyManagementCapability(capability, binding, { personId: profile.identity.personId,
      deviceId: profile.device.deviceId, resourceKind: binding.resourceKind, resourceId: binding.resourceId, operation,
      minimumRevision: capability.payload.revision })
    return canonicalizeJson(capability ?? null)
  }
}

/** Confirm current server policy before a management action; known migration never falls back to older controller ancestry. */
export async function resolveRustyManagementAuthority(binding: ManagementBinding, profile: LocalProfile, operation: string,
  supported: boolean, guard: ManagementClientGuard = {}): Promise<SignedEnvelope<RustyManagementCapability> | undefined> {
  binding = structuredClone(binding)
  profile = structuredClone(profile)
  validatePolicy({ resourceKind: binding.resourceKind, operations: [...new Set(["management.update", operation])].sort(), revokedDeviceIds: [] })
  const saved = await repo(profile).read(binding)
  if (!supported) {
    const parent = await repo(profile).read({ ...binding, resourceKind: "person", resourceId: profile.identity.personId })
    if (saved || parent) throw new Error("Rusty upgrade required before this connection can use its saved permissions")
    return undefined
  }
  const status = await readRustyManagementStatus(binding, profile, guard)
  if (status.migrationPending || (await repo(profile).read(binding))?.pending) throw new Error("Rusty management migration is pending; retry or review the saved request")
  if (!status.capability) {
    const parent = await repo(profile).read({ ...binding, resourceKind: "person", resourceId: profile.identity.personId })
    if (!parent?.capability) return undefined
    const operations = binding.resourceKind === "scope" ? ["management.update", "scope.policy", "snapshot.checkpoint"] :
      ["management.update", "publication.status", "publication.publish", "publication.update", "publication.unpublish", "publication.stage-file"]
    const created = await updateRustyManagementPolicy(binding, profile, { operations, revokedDeviceIds: [] }, guard)
    await verifyRustyManagementCapability(created, binding, { personId: profile.identity.personId, deviceId: profile.device.deviceId,
      resourceKind: binding.resourceKind, resourceId: binding.resourceId, operation, minimumRevision: created.payload.revision })
    return created
  }
  await verifyRustyManagementCapability(status.capability, binding, { personId: profile.identity.personId, deviceId: profile.device.deviceId,
    resourceKind: binding.resourceKind, resourceId: binding.resourceId, operation, minimumRevision: status.revision })
  return status.capability
}

async function assertDevice(profile: LocalProfile, guard: ManagementClientGuard): Promise<void> {
  await guard.ensureCurrent?.()
  const current = await bootstrapIdentity()
  if (current.identity.personId !== profile.identity.personId || current.device.deviceId !== profile.device.deviceId ||
    current.certificate.signature !== profile.certificate.signature) throw new Error("Rusty management signing identity is stale")
  await guard.ensureCurrent?.()
}

async function context(binding: ManagementBinding, profile: LocalProfile, purpose: string, expiresAt: number, guard: ManagementClientGuard) {
  const serviceId = await sha256Base64Url(decodeBlindBytes(binding.servicePublicKey))
  return resolveLocalSigningContext(profile, purpose, { serviceId, origin: binding.origin, personId: profile.identity.personId,
    deviceId: profile.device.deviceId, resourceKind: binding.resourceKind, resourceId: binding.resourceId }, {
    expiresAt, ensureCurrent: guard.ensureCurrent,
    currentAuthority: async () => canonicalizeJson([await localManagementAuthority(binding, profile), await guard.currentAuthority?.() ?? ""]),
  })
}

async function localManagementAuthority(binding: ManagementBinding, profile: LocalProfile) {
  const repository = repo(profile)
  const parent = await repository.read({ ...binding, resourceKind: "person", resourceId: profile.identity.personId })
  if (parent?.capability?.payload.revokedDeviceIds.includes(profile.device.deviceId)) throw new Error("Person policy revoked this device")
  if (binding.resourceKind !== "person" && parent?.pending) throw new Error("Person policy update is pending")
  const current = await repository.read(binding)
  return [current?.capability ?? null, parent?.capability ?? null, parent?.pending ?? null]
}

async function creationAuthority(binding: ManagementBinding, profile: LocalProfile) {
  if (binding.resourceKind === "person") {
    if (binding.resourceId !== profile.identity.personId) throw new Error("Person policy must match this identity")
    return undefined
  }
  const parent = await repo(profile).read({ ...binding, resourceKind: "person", resourceId: profile.identity.personId })
  if (parent?.pending) throw new Error("Person creation policy update is pending")
  if (!parent?.capability) return undefined
  await verifyRustyManagementCapability(parent.capability, binding, { personId: profile.identity.personId, deviceId: profile.device.deviceId,
    resourceKind: "person", resourceId: profile.identity.personId, operation: "resource.create", minimumRevision: parent.capability.payload.revision })
  return parent.capability
}

/** One explicit migration establishes person creation rights. Subsequent devices read current signed policy without ancestry repair. */
export async function ensureRustyPersonPolicy(access: Pick<ManagementBinding, "origin" | "servicePublicKey">, profile: LocalProfile,
  supported: boolean, guard: ManagementClientGuard = {}) {
  const binding: ManagementBinding = { origin: access.origin, servicePublicKey: access.servicePublicKey,
    resourceKind: "person", resourceId: profile.identity.personId }
  const saved = await repo(profile).read(binding)
  if (!supported) {
    if (saved) throw new Error("Rusty upgrade required for this saved person policy")
    return undefined
  }
  const status = await readRustyManagementStatus(binding, profile, guard)
  const current = await repo(profile).read(binding)
  let cap = status.capability ?? undefined
  if (current?.pending) cap = await retryRustyManagementUpdate(binding, profile, guard)
  else if (status.migrationPending) throw new Error("Person policy migration is pending; recover the saved request")
  else if (!cap) cap = await updateRustyManagementPolicy(binding, profile, { operations: ["management.update", "resource.create"], revokedDeviceIds: [] }, guard)
  await verifyRustyManagementCapability(cap, binding, { personId: profile.identity.personId, deviceId: profile.device.deviceId,
    resourceKind: "person", resourceId: profile.identity.personId, operation: "management.update", minimumRevision: cap.payload.revision })
  return cap
}

/** Status reads are signed and private. They never provision or migrate a resource. */
export async function readRustyManagementStatus(binding: ManagementBinding, profile: LocalProfile, guard: ManagementClientGuard = {}) {
  binding = structuredClone(binding)
  profile = structuredClone(profile)
  const issuedAt = Date.now()
  const signing = await context(binding, profile, "rusty-management-policy-status", issuedAt + 120_000, guard)
  const evidence = signingEvidence(signing)
  const authorization = await signWithContext(signing, {
    kind: "rusty-management-policy-status", version: 1, serviceId: await sha256Base64Url(decodeBlindBytes(binding.servicePublicKey)),
    origin: binding.origin, personId: profile.identity.personId, deviceId: profile.device.deviceId,
    resourceKind: binding.resourceKind, resourceId: binding.resourceId, requestId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + 120_000,
  } satisfies ManagementStatusAuthorization)
  const minimumRevision = await revision(binding, profile)
  await assertDevice(profile, guard)
  const response = await readBlindJson<RustyManagementStatusResponse>(await fetchBlind(`${path(binding)}/status`, {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, identity: evidence.identity, deviceId: profile.device.deviceId, certificates: evidence.certificates, authorization }),
  }), 1024 * 1024)
  const verified = await verifyRustyManagementStatus(response, binding, { personId: profile.identity.personId, deviceId: profile.device.deviceId,
    resourceKind: binding.resourceKind, resourceId: binding.resourceId, operation: "management.update", minimumRevision }, authorization)
  await assertDevice(profile, guard)
  if (response.capability) await repo(profile).observe(binding, response.capability)
  else if (await revision(binding, profile) > 0) throw new Error("Rusty management authority rolled back during status verification")
  return { ...verified, capability: response.capability }
}

/** Explicit owner action only. Persist one exact request before the first network attempt. */
export async function updateRustyManagementPolicy(binding: ManagementBinding, profile: LocalProfile,
  policy: { operations: string[]; revokedDeviceIds: string[] }, guard: ManagementClientGuard = {}): Promise<SignedEnvelope<RustyManagementCapability>> {
  binding = structuredClone(binding)
  profile = structuredClone(profile)
  policy = structuredClone(policy)
  policy.operations.sort(); policy.revokedDeviceIds.sort()
  validatePolicy({ ...policy, resourceKind: binding.resourceKind })
  const repository = repo(profile)
  const saved = await repository.read(binding)
  if (saved?.pending) throw new Error("A Rusty management request is pending; retry or review it first")
  const parent = saved?.capability ? undefined : await creationAuthority(binding, profile)
  if (saved?.capability) await verifyRustyManagementCapability(saved.capability, binding, { personId: profile.identity.personId,
    deviceId: profile.device.deviceId, resourceKind: binding.resourceKind, resourceId: binding.resourceId,
    operation: "management.update", minimumRevision: saved.capability.payload.revision })
  const issuedAt = Date.now()
  const signing = await context(binding, profile, "rusty-management-policy-update", issuedAt + 120_000, guard)
  const evidence = signingEvidence(signing)
  const authorization = await signWithContext(signing, {
    kind: "rusty-management-policy-update", version: 1, serviceId: await sha256Base64Url(decodeBlindBytes(binding.servicePublicKey)),
    origin: binding.origin, personId: profile.identity.personId, deviceId: profile.device.deviceId,
    resourceKind: binding.resourceKind, resourceId: binding.resourceId, expectedRevision: saved?.capability?.payload.revision ?? 0,
    ...policy, requestId: crypto.randomUUID(), issuedAt, expiresAt: issuedAt + 120_000,
    ...(parent ? { personManagementRevision: parent.payload.revision } : {}),
  } satisfies ManagementUpdateAuthorization)
  await assertDevice(profile, guard)
  await repository.prepare(binding, { version: 1, identity: evidence.identity, deviceId: profile.device.deviceId, certificates: evidence.certificates,
    ...(saved?.capability ? { managementCapability: saved.capability } : {}),
    ...(parent ? { personManagementCapability: parent } : {}), authorization })
  return retryRustyManagementUpdate(binding, profile, guard)
}

/** Reuse persisted ciphertext-free signed intent, including after expiry. Rusty alone decides whether a completed retry is valid. */
export async function retryRustyManagementUpdate(binding: ManagementBinding, profile: LocalProfile, guard: ManagementClientGuard = {}): Promise<SignedEnvelope<RustyManagementCapability>> {
  binding = structuredClone(binding)
  profile = structuredClone(profile)
  const repository = repo(profile)
  const saved = await repository.read(binding)
  if (!saved?.pending) throw new Error("No Rusty management request is pending")
  const pending = saved.pending
  if (pending.deviceId !== profile.device.deviceId || pending.identity.personId !== profile.identity.personId) {
    throw new Error("Pending Rusty management request belongs to another device; refresh confirmed status")
  }
  if ((saved.capability?.payload.revision ?? 0) !== pending.authorization.payload.expectedRevision) {
    throw new Error("Pending Rusty management request was superseded; owner review required")
  }
  // Verify the live key and certified chain even though retries reuse the original signature.
  await context(binding, profile, "rusty-management-policy-update", Date.now() + 120_000, guard)
  await assertDevice(profile, guard)
  const response = await readBlindJson<{ capability: SignedEnvelope<RustyManagementCapability> }>(await fetchBlind(path(binding), {
    method: "PUT", signal: AbortSignal.timeout(30_000), headers: { "Content-Type": "application/json" }, body: JSON.stringify(pending),
  }), 1024 * 1024)
  if (!response || Object.keys(response).length !== 1) throw new Error("Invalid Rusty management update response")
  const cap = await verifyRustyManagementEvidence(response.capability, binding, { personId: profile.identity.personId,
    resourceKind: binding.resourceKind, resourceId: binding.resourceId, minimumRevision: pending.authorization.payload.expectedRevision + 1 })
  await verifyConfirmation(cap, pending)
  await assertDevice(profile, guard)
  await repository.observe(binding, response.capability)
  return structuredClone(response.capability)
}

async function verifyConfirmation(cap: RustyManagementCapability, pending: ManagementUpdateRequest): Promise<void> {
  const auth = pending.authorization.payload
  if (cap.revision !== auth.expectedRevision + 1 || cap.requestId !== auth.requestId ||
    cap.authorizationHash !== await sha256Base64Url(encoder.encode(canonicalizeJson(pending.authorization))) ||
    canonicalizeJson(cap.operations) !== canonicalizeJson(auth.operations) || canonicalizeJson(cap.revokedDeviceIds) !== canonicalizeJson(auth.revokedDeviceIds)) {
    throw new Error("Rusty management response does not cover pending request intent")
  }
}
