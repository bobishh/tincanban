import { captureIdentityProfile } from "../domain/identity"
import { canonicalizeJson, sha256Base64Url, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { verifyDeviceCertificateChain } from "@meta-uber/mesh-identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { assertSigningContextCurrent, signWithContext } from "../domain/signingContext"
import type { DeviceCertificate, PublicIdentity } from "../domain/model"
import { blindHash, discoverBlindKeeper, type BlindAccess } from "./blindClient"
import { fetchBlind, readBlindJson } from "./rustyHttp"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { resolveRustyManagementAuthority, rustyManagementAuthorityRevision } from "./rustyManagementClient"
import type { RustyScopePolicyReceipt } from "../product-replica"
import type { RustyManagementCapability } from "./rustyManagementCapability"
import type { RustyServicePin } from "@meta-uber/mesh-replication/rusty-management"
import { verifyRustyManagementEvidence } from "./rustyManagementCapability"
import { completeScopeEnrollmentIntent, prepareScopeEnrollmentIntent, readScopeEnrollmentIntent, replaceScopeEnrollmentIntent,
  type ScopeEnrollmentBinding, type ScopeEnrollmentIntent } from "./rustyEnrollmentJournal"
import { parseRustyScopePolicyReceipt } from "../product-replica"
import { createRustyScopeEnrollmentClient } from "@meta-uber/mesh-replication/rusty-scope-enrollment"
import { rustySignerCertificateChain } from "./rustySignerCertificates"

type Challenge = {
  kind: "rusty-enrollment-challenge"; version: 1; challengeId: string; nonce: string; serviceId: string;
  publicOrigin: string; scopeId: string; personId: string; deviceId: string; deviceKeyId: string;
  expectedRevision: number; scopePurpose?: "workspace" | "person-identity"; issuedAt: number; expiresAt: number;
}
type PolicyReceipt = {
  kind: "rusty-scope-policy-receipt"; version: 1; serviceId: string; scopeId: string; personId: string;
  revision: number; revoked: boolean; challengeId: string; authorizationHash: string; minimumWriterVersion?: 2;
  scopePurpose?: "workspace" | "person-identity";
}
type EnrollmentAuthorization = {
  kind: "rusty-scope-enrollment"; version: 1; challengeId: string; nonce: string; serviceId: string; publicOrigin: string;
  scopeId: string; personId: string; deviceId: string; deviceKeyId: string; expectedRevision: number;
  readTokenHash: string; writeTokenHash: string; revoked: boolean; expiresAt: number;
  minimumWriterVersion?: 2; managementRevision?: number; scopePurpose?: "workspace" | "person-identity";
}
type EnrollmentRequest = { challenge: SignedEnvelope<Challenge>; identity: PublicIdentity; deviceId: string;
  certificates: DeviceCertificate[]; managementCapability?: SignedEnvelope<RustyManagementCapability>;
  readToken: string; writeToken: string; revoked: boolean; authorization: SignedEnvelope<EnrollmentAuthorization> }

export type RustyScopeEnrollmentOptions = { minimumWriterVersion?: 2; ensureCurrent?: () => void | Promise<void>;
  requireExactRetry?: boolean; expectedPolicyRevision?: number; scopePurpose?: "workspace" | "person-identity";
  confirmed?: (receipt: RustyScopePolicyReceipt) => void | Promise<void> }

function assertEnrollmentOptions(minimumWriterVersion: number | undefined, expectedPolicyRevision: number | undefined) {
  if (minimumWriterVersion !== undefined && minimumWriterVersion !== 2) throw new Error("Unsupported Rusty writer version")
  if (expectedPolicyRevision !== undefined && (!Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision < 0)) throw new Error("Invalid expected scope policy revision")
}

function assertEnrollmentService(service: RustyServicePin, access: BlindAccess, minimumWriterVersion?: 2) {
  if (service.servicePublicKey !== access.servicePublicKey) throw new Error("Rusty management service pin changed")
  if (minimumWriterVersion === 2 && featureObject(service, "writerPolicy")?.maximumWriterVersion !== 2)
    throw new Error("Rusty service does not advertise the requested writer policy")
}

function featureObject(service: RustyServicePin, name: string): Record<string, unknown> | undefined {
  const value = service.capabilities[name]
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

type ScopeAccessPin = Pick<BlindAccess, "origin" | "scopeId" | "servicePublicKey">

async function verifyService<T extends { kind: string }>(value: SignedEnvelope<T>, access: ScopeAccessPin, serviceId: string) {
  if (!value?.payload || value.signerKeyId !== serviceId || !await verifyEnvelope(value, access.servicePublicKey, "RUSTY/2")) {
    throw new Error("Rusty signature invalid")
  }
}

function validateChallenge(payload: Challenge, access: ScopeAccessPin, profile: LocalProfile, serviceId: string, allowExpired = false) {
  const now = Date.now()
  if (payload.kind !== "rusty-enrollment-challenge" || payload.version !== 1 || payload.serviceId !== serviceId ||
    payload.publicOrigin !== blindOrigin(access.origin) || payload.scopeId !== access.scopeId || payload.personId !== profile.identity.personId ||
    payload.deviceId !== profile.device.deviceId || payload.deviceKeyId !== profile.device.deviceId || !payload.challengeId || !payload.nonce ||
    !validChallengeTiming(payload, now, allowExpired)) throw new Error("Rusty challenge does not cover this connection")
}

/** Read a pinned, signed policy revision without installing credentials or consuming its challenge. */
export async function readRustyScopePolicyRevision(access: ScopeAccessPin, profile: LocalProfile,
  ensureCurrent: () => void | Promise<void>): Promise<number> {
  access = { ...access, origin: blindOrigin(access.origin) }
  profile = captureIdentityProfile(profile)
  await ensureCurrent()
  const context = await resolveLocalSigningContext(profile, "rusty-controller-proof", { personId: profile.identity.personId }, { ensureCurrent })
  const binding = { origin: access.origin, servicePublicKey: access.servicePublicKey, resourceKind: "scope" as const, resourceId: access.scopeId }
  const service = await discoverBlindKeeper(access.origin)
  await assertSigningContextCurrent(context)
  await ensureCurrent()
  if (service.servicePublicKey !== access.servicePublicKey) throw new Error("Rusty management service pin changed")
  const capability = await resolveRustyManagementAuthority(binding, profile, "scope.policy", service.scopeManagement === 1)
  const certificates = await rustySignerCertificateChain(profile)
  const authority = rustyManagementAuthorityRevision(binding, profile, "scope.policy", capability)
  const guard = async () => { await assertSigningContextCurrent(context); await authority(); await ensureCurrent() }
  await guard()
  const response = await fetchBlind(`${access.origin}/v2/enrollment/challenge`, {
    method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, scopeId: access.scopeId, identity: profile.identity, deviceId: profile.device.deviceId,
      certificates, ...(capability ? { managementCapability: capability } : {}) }),
  })
  await guard()
  const { challenge } = await readBlindJson<{ challenge: SignedEnvelope<Challenge> }>(response, 65536)
  const serviceId = await blindHash(decodeBlindBytes(access.servicePublicKey))
  await verifyService(challenge, access, serviceId)
  validateChallenge(challenge.payload, access, profile, serviceId)
  await guard()
  return challenge.payload.expectedRevision
}

function validChallengeTiming(payload: Challenge, now: number, allowExpired: boolean): boolean {
  return Number.isSafeInteger(payload.expectedRevision) && payload.expectedRevision >= 0 && payload.expectedRevision < Number.MAX_SAFE_INTEGER && Number.isSafeInteger(payload.issuedAt) &&
    Number.isSafeInteger(payload.expiresAt) && payload.issuedAt >= 0 && payload.issuedAt <= now + 5000 && (allowExpired || payload.expiresAt > now) &&
    payload.expiresAt - payload.issuedAt <= 120000 && payload.expiresAt > payload.issuedAt
}

/** Public identity evidence and scoped storage credentials leave the browser; content keys stay local. */
export async function approveRustyScope(access: BlindAccess, profile: LocalProfile, revoked = false,
  options: RustyScopeEnrollmentOptions = {}): Promise<number> {
  const ensureCurrentOption = options.ensureCurrent
  const confirmed = options.confirmed
  const requireExactRetry = options.requireExactRetry === true
  const minimumWriterVersion = options.minimumWriterVersion
  const expectedPolicyRevision = options.expectedPolicyRevision
  const scopePurpose = options.scopePurpose
  access = { ...access }
  profile = captureIdentityProfile(profile)
  assertEnrollmentOptions(minimumWriterVersion, expectedPolicyRevision)
  await ensureCurrentOption?.()
  const controllerContext = await resolveLocalSigningContext(profile, "rusty-controller-proof", { personId: profile.identity.personId },
    { ensureCurrent: ensureCurrentOption })
  const certificates = await rustySignerCertificateChain(profile)
  let assertAuthority: () => Promise<unknown> = async () => undefined
  const assertCurrent = async () => { await assertSigningContextCurrent(controllerContext); await assertAuthority(); await ensureCurrentOption?.() }
  const publicOrigin = blindOrigin(access.origin)
  const binding = { origin: publicOrigin, servicePublicKey: access.servicePublicKey, resourceKind: "scope" as const, resourceId: access.scopeId }
  let managementCapability: SignedEnvelope<RustyManagementCapability> | undefined
  const assertManagementAuthority = async () => managementCapability
    ? rustyManagementAuthorityRevision(binding, profile, "scope.policy", managementCapability)()
    : canonicalizeJson(null)
  const ensureCurrent = async () => { await assertCurrent(); await assertManagementAuthority() }
  const client = createRustyScopeEnrollmentClient({
    access: { origin: publicOrigin, scopeId: access.scopeId, servicePublicKey: access.servicePublicKey,
      readToken: access.readToken, writeToken: access.writeToken },
    identity: profile.identity, deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey,
    certificates,
    scopePurpose,
    ensureCurrent,
    getManagementCapability: async service => {
      await ensureCurrent()
      assertEnrollmentService(service, access, minimumWriterVersion)
      const supportsManagement = service.capabilities.scopeManagement === 1 || featureObject(service, "scopeManagement")?.version === 1
      managementCapability = await resolveRustyManagementAuthority(binding, profile, "scope.policy", supportsManagement, { provision: true, ensureCurrent })
      assertAuthority = rustyManagementAuthorityRevision(binding, profile, "scope.policy", managementCapability)
      await ensureCurrent()
      return managementCapability
    },
    ensureManagementCurrent: async capability => {
      await ensureCurrent()
      if (canonicalizeJson(capability ?? null) !== canonicalizeJson(managementCapability ?? null)) {
        throw new Error("Rusty management authority changed during scope enrollment")
      }
    },
    signAuthorization: async (payload, challenge) => {
      const serviceId = challenge.payload.serviceId
      const context = await resolveLocalSigningContext(profile, "rusty-scope-enrollment", {
        scopeId: access.scopeId, publicOrigin, serviceId, personId: profile.identity.personId,
        deviceId: profile.device.deviceId, challengeId: challenge.payload.challengeId, nonce: challenge.payload.nonce,
        ...(scopePurpose ? { scopePurpose } : {}),
        ...(minimumWriterVersion === undefined ? {} : { minimumWriterVersion }),
      }, { certificates, expiresAt: payload.expiresAt,
        ensureCurrent, currentAuthority: assertManagementAuthority })
      await ensureCurrent()
      return signWithContext(context, payload)
    },
    journal: {
      read: async binding => {
        const saved = await readScopeEnrollmentIntent(binding as ScopeEnrollmentBinding)
        return saved ? { body: saved.body } : undefined
      },
      prepare: (binding, body, current) => prepareScopeEnrollmentIntent(binding as ScopeEnrollmentBinding, body, current),
      replace: (binding, previousBody, body, current) => replaceScopeEnrollmentIntent(binding as ScopeEnrollmentBinding, previousBody, body, current),
      complete: (binding, body, current) => completeScopeEnrollmentIntent(binding as ScopeEnrollmentBinding, body, current),
    },
  })
  const result = await client.enroll({ revoked, minimumWriterVersion, requireExactRetry, expectedPolicyRevision,
    allowLegacyUnmanagedScope: true,
    confirmed: async receipt => { await confirmed?.(parseRustyScopePolicyReceipt(receipt)) } })
  return result.policyRevision
}

function requireFields(value: unknown, required: string[], optional: string[] = []): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(field => !Object.hasOwn(value, field)) ||
    Object.keys(value).some(field => !required.includes(field) && !optional.includes(field))) {
    throw new Error("Invalid saved Rusty enrollment request fields")
  }
}

/** Stored requests remain historical signatures; only Rusty can confirm an expired request was already committed. */
async function verifyEnrollmentRequest(body: string, access: BlindAccess, profile: LocalProfile, serviceId: string,
  managementCapability: SignedEnvelope<RustyManagementCapability> | undefined, intent: ScopeEnrollmentBinding,
  allowExpired: boolean): Promise<EnrollmentRequest> {
  const request = JSON.parse(body) as EnrollmentRequest
  requireFields(request, ["challenge", "identity", "deviceId", "certificates", "readToken", "writeToken", "revoked", "authorization"], ["managementCapability"])
  requireFields(request.authorization, ["payload", "signerKeyId", "signature"])
  requireFields(request.challenge, ["payload", "signerKeyId", "signature"])
  requireFields(request.identity, ["personId", "publicKey", "displayName"])
  const proof = request.authorization.payload
  requireFields(proof, ["kind", "version", "challengeId", "nonce", "serviceId", "publicOrigin", "scopeId", "personId", "deviceId",
    "deviceKeyId", "expectedRevision", "readTokenHash", "writeTokenHash", "revoked", "expiresAt"], ["minimumWriterVersion", "managementRevision", "scopePurpose"])
  assertEnrollmentConnection(request, access, profile, intent, managementCapability)
  await verifyService(request.challenge, access, serviceId)
  validateChallenge(request.challenge.payload, access, profile, serviceId, allowExpired)
  const challenge = request.challenge.payload
  if (challenge.scopePurpose !== intent.scopePurpose) throw new Error("Saved Rusty enrollment scope purpose changed")
  assertEnrollmentAuthorization(proof, challenge, intent, serviceId, managementCapability, request.authorization.signerKeyId)
  const publicKey = await verifyDeviceCertificateChain(request.identity, request.deviceId, request.certificates, "MATCH/1")
  if (publicKey !== profile.device.publicKey || !await verifyEnvelope(request.authorization, publicKey)) {
    throw new Error("Saved Rusty enrollment authorization signature invalid")
  }
  return request
}

function assertEnrollmentConnection(request: EnrollmentRequest, access: BlindAccess, profile: LocalProfile, intent: ScopeEnrollmentBinding,
  managementCapability: SignedEnvelope<RustyManagementCapability> | undefined) {
  if (request.identity.personId !== profile.identity.personId || request.identity.publicKey !== profile.identity.publicKey ||
    typeof request.identity.displayName !== "string" || request.deviceId !== profile.device.deviceId ||
    request.readToken !== access.readToken || request.writeToken !== access.writeToken || request.revoked !== intent.revoked ||
    !Array.isArray(request.certificates) || request.certificates.length < 1 || request.certificates.length > 32 ||
    canonicalizeJson(request.managementCapability ?? null) !== canonicalizeJson(managementCapability ?? null)) {
    throw new Error("Saved Rusty enrollment request no longer matches this connection or authority")
  }
}

function assertEnrollmentAuthorization(proof: EnrollmentAuthorization, challenge: Challenge, intent: ScopeEnrollmentBinding,
  serviceId: string, managementCapability: SignedEnvelope<RustyManagementCapability> | undefined, signerKeyId: string) {
  const expected: EnrollmentAuthorization = { kind: "rusty-scope-enrollment", version: 1, challengeId: challenge.challengeId,
    nonce: challenge.nonce, serviceId, publicOrigin: intent.origin, scopeId: intent.scopeId, personId: intent.personId,
    deviceId: intent.deviceId, deviceKeyId: intent.deviceId, expectedRevision: challenge.expectedRevision, expiresAt: challenge.expiresAt,
    readTokenHash: intent.readTokenHash, writeTokenHash: intent.writeTokenHash, revoked: intent.revoked,
    ...(intent.scopePurpose ? { scopePurpose: intent.scopePurpose } : {}),
    minimumWriterVersion: intent.minimumWriterVersion, managementRevision: managementCapability?.payload.revision }
  if (signerKeyId !== intent.deviceId || Object.entries(expected).some(([key, value]) => proof[key as keyof EnrollmentAuthorization] !== value))
    throw new Error("Saved Rusty enrollment authorization binding invalid")
}

function receiptCoversEnrollment(receipt: PolicyReceipt, expected: { serviceId: string; scopeId: string; personId: string;
  revision: number; revoked: boolean; challengeId: string; authorizationHash: string; minimumWriterVersion?: 2;
  scopePurpose?: "workspace" | "person-identity" }): boolean {
  const revisionMatches = receipt.revision === expected.revision + 1 ||
    (expected.minimumWriterVersion === 2 && receipt.revision === expected.revision)
  const writerVersionMatches = expected.minimumWriterVersion === 2
    ? receipt.minimumWriterVersion === 2
    : !Object.hasOwn(receipt, "minimumWriterVersion") || receipt.minimumWriterVersion === 2
  return receipt.kind === "rusty-scope-policy-receipt" && receipt.version === 1 && receipt.serviceId === expected.serviceId &&
    receipt.scopeId === expected.scopeId && receipt.personId === expected.personId && revisionMatches &&
    receipt.revoked === expected.revoked && receipt.challengeId === expected.challengeId && receipt.scopePurpose === expected.scopePurpose &&
    receipt.authorizationHash === expected.authorizationHash && writerVersionMatches
}

/** Retained transition evidence must bind the exact original token request, not merely a valid scope receipt. */
export async function verifySavedScopeEnrollmentConfirmation(access: BlindAccess, profile: LocalProfile,
  saved: ScopeEnrollmentIntent, value: unknown): Promise<RustyScopePolicyReceipt> {
  access = structuredClone(access)
  profile = captureIdentityProfile(profile)
  saved = structuredClone(saved)
  const receipt = parseRustyScopePolicyReceipt(value)
  const serviceId = await blindHash(decodeBlindBytes(access.servicePublicKey))
  const expected: ScopeEnrollmentBinding = { origin: blindOrigin(access.origin), scopeId: access.scopeId,
    servicePublicKey: access.servicePublicKey, personId: profile.identity.personId, deviceId: profile.device.deviceId,
    readTokenHash: await sha256Base64Url(new TextEncoder().encode(access.readToken)),
    writeTokenHash: await sha256Base64Url(new TextEncoder().encode(access.writeToken)), revoked: false,
    ...(saved.binding.minimumWriterVersion === 2 ? { minimumWriterVersion: 2 } : {}),
    ...(saved.binding.scopePurpose ? { scopePurpose: saved.binding.scopePurpose } : {}) }
  if (saved.version !== 1 || canonicalizeJson(saved.binding) !== canonicalizeJson(expected)) throw new Error("Retained enrollment confirmation targets different tokens or identity")
  const raw = JSON.parse(saved.body) as EnrollmentRequest
  if (!raw.managementCapability) throw new Error("Credential transition requires explicit scope management authority")
  await verifyRustyManagementEvidence(raw.managementCapability, access, { personId: profile.identity.personId,
    resourceKind: "scope", resourceId: access.scopeId, minimumRevision: 1 })
  const request = await verifyEnrollmentRequest(saved.body, access, profile, serviceId, raw.managementCapability, expected, true)
  await verifyService(receipt, access, serviceId)
  if (!receiptCoversEnrollment(receipt.payload, { serviceId, scopeId: access.scopeId, personId: profile.identity.personId,
    revision: request.authorization.payload.expectedRevision, revoked: false, challengeId: request.challenge.payload.challengeId,
    authorizationHash: await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(request.authorization))),
    minimumWriterVersion: expected.minimumWriterVersion, scopePurpose: expected.scopePurpose })) throw new Error("Retained scope receipt does not confirm the original credential request")
  return receipt
}
