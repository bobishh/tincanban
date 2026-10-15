import { canonicalizeJson, sha256Base64Url, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { verifyDeviceCertificateChain } from "@meta-uber/mesh-identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { assertSigningContextCurrent, signingEvidence, signWithContext } from "../domain/signingContext"
import type { DeviceCertificate, PublicIdentity } from "../domain/model"
import { blindHash, blindOrigin, discoverBlindKeeper, fetchBlind, readBlindJson, type BlindAccess } from "./blindClient"
import { decodeBlindBytes } from "./blindEnvelope"
import { resolveRustyManagementAuthority, rustyManagementAuthorityRevision } from "./rustyManagementClient"
import type { RustyScopePolicyReceipt } from "./rustyScopePolicy"
import type { RustyManagementCapability } from "./rustyManagementCapability"
import { verifyRustyManagementEvidence } from "./rustyManagementCapability"
import { completeScopeEnrollmentIntent, prepareScopeEnrollmentIntent, readScopeEnrollmentIntent, replaceScopeEnrollmentIntent,
  type ScopeEnrollmentBinding, type ScopeEnrollmentIntent } from "./rustyEnrollmentJournal"
import { parseRustyScopePolicyReceipt } from "./rustyScopePolicy"

type Challenge = {
  kind: "rusty-enrollment-challenge"; version: 1; challengeId: string; nonce: string; serviceId: string;
  publicOrigin: string; scopeId: string; personId: string; deviceId: string; deviceKeyId: string;
  expectedRevision: number; issuedAt: number; expiresAt: number;
}
type PolicyReceipt = {
  kind: "rusty-scope-policy-receipt"; version: 1; serviceId: string; scopeId: string; personId: string;
  revision: number; revoked: boolean; challengeId: string; authorizationHash: string; minimumWriterVersion?: 2;
}
type EnrollmentAuthorization = {
  kind: "rusty-scope-enrollment"; version: 1; challengeId: string; nonce: string; serviceId: string; publicOrigin: string;
  scopeId: string; personId: string; deviceId: string; deviceKeyId: string; expectedRevision: number;
  readTokenHash: string; writeTokenHash: string; revoked: boolean; expiresAt: number;
  minimumWriterVersion?: 2; managementRevision?: number;
}
type EnrollmentRequest = { challenge: SignedEnvelope<Challenge>; identity: PublicIdentity; deviceId: string;
  certificates: DeviceCertificate[]; managementCapability?: SignedEnvelope<RustyManagementCapability>;
  readToken: string; writeToken: string; revoked: boolean; authorization: SignedEnvelope<EnrollmentAuthorization> }

export type RustyScopeEnrollmentOptions = { minimumWriterVersion?: 2; ensureCurrent?: () => void | Promise<void>;
  requireExactRetry?: boolean; expectedPolicyRevision?: number;
  confirmed?: (receipt: RustyScopePolicyReceipt) => void | Promise<void> }

function assertEnrollmentOptions(minimumWriterVersion: number | undefined, expectedPolicyRevision: number | undefined) {
  if (minimumWriterVersion !== undefined && minimumWriterVersion !== 2) throw new Error("Unsupported Rusty writer version")
  if (expectedPolicyRevision !== undefined && (!Number.isSafeInteger(expectedPolicyRevision) || expectedPolicyRevision < 0)) throw new Error("Invalid expected scope policy revision")
}

function assertEnrollmentService(service: Awaited<ReturnType<typeof discoverBlindKeeper>>, access: BlindAccess, minimumWriterVersion?: 2) {
  if (service.servicePublicKey !== access.servicePublicKey) throw new Error("Rusty management service pin changed")
  if (minimumWriterVersion === 2 && service.writerPolicy?.maximumWriterVersion !== 2)
    throw new Error("Rusty service does not advertise the requested writer policy")
}

function assertExpectedPolicyRevision(expected: number | undefined, request: EnrollmentRequest) {
  if (expected !== undefined && request.authorization.payload.expectedRevision !== expected) {
    throw new Error("Concurrent Rusty scope policy revision changed; original credentials retained for review")
  }
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
  profile = structuredClone(profile)
  await ensureCurrent()
  const context = await resolveLocalSigningContext(profile, "rusty-controller-proof", { personId: profile.identity.personId }, { ensureCurrent })
  const binding = { origin: access.origin, servicePublicKey: access.servicePublicKey, resourceKind: "scope" as const, resourceId: access.scopeId }
  const service = await discoverBlindKeeper(access.origin)
  await assertSigningContextCurrent(context)
  await ensureCurrent()
  if (service.servicePublicKey !== access.servicePublicKey) throw new Error("Rusty management service pin changed")
  const capability = await resolveRustyManagementAuthority(binding, profile, "scope.policy", service.scopeManagement === 1)
  const authority = rustyManagementAuthorityRevision(binding, profile, "scope.policy", capability)
  const guard = async () => { await assertSigningContextCurrent(context); await authority(); await ensureCurrent() }
  await guard()
  const response = await fetchBlind(`${access.origin}/v2/enrollment/challenge`, {
    method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, scopeId: access.scopeId, identity: profile.identity, deviceId: profile.device.deviceId,
      certificates: signingEvidence(context).certificates, ...(capability ? { managementCapability: capability } : {}) }),
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
  access = { ...access }
  profile = structuredClone(profile)
  assertEnrollmentOptions(minimumWriterVersion, expectedPolicyRevision)
  await ensureCurrentOption?.()
  const controllerContext = await resolveLocalSigningContext(profile, "rusty-controller-proof", { personId: profile.identity.personId },
    { ensureCurrent: ensureCurrentOption })
  let assertAuthority: () => Promise<unknown> = async () => undefined
  const assertCurrent = async () => { await assertSigningContextCurrent(controllerContext); await assertAuthority(); await ensureCurrentOption?.() }
  const publicOrigin = blindOrigin(access.origin)
  const serviceId = await blindHash(decodeBlindBytes(access.servicePublicKey))
  await assertCurrent()
  const controller = { identity: profile.identity, deviceId: profile.device.deviceId,
    certificates: signingEvidence(controllerContext).certificates }
  await assertCurrent()
  const service = await discoverBlindKeeper(publicOrigin)
  await assertCurrent()
  assertEnrollmentService(service, access, minimumWriterVersion)
  const intentBinding: ScopeEnrollmentBinding = { origin: publicOrigin, scopeId: access.scopeId, servicePublicKey: access.servicePublicKey,
    personId: profile.identity.personId, deviceId: profile.device.deviceId,
    readTokenHash: await sha256Base64Url(new TextEncoder().encode(access.readToken)),
    writeTokenHash: await sha256Base64Url(new TextEncoder().encode(access.writeToken)), revoked,
    ...(minimumWriterVersion === undefined ? {} : { minimumWriterVersion }) }
  const pending = await readScopeEnrollmentIntent(intentBinding)
  if ((pending || requireExactRetry) && service.scopeEnrollmentRetry !== 1) {
    throw new Error("Rusty upgrade required for recoverable scope enrollment")
  }
  const binding = { origin: publicOrigin, servicePublicKey: access.servicePublicKey, resourceKind: "scope" as const, resourceId: access.scopeId }
  const managementCapability = await resolveRustyManagementAuthority(binding, profile, "scope.policy", service.scopeManagement === 1)
  assertAuthority = rustyManagementAuthorityRevision(binding, profile, "scope.policy", managementCapability)
  await assertCurrent()
  const initialBody = pending?.body ?? await createEnrollmentRequest(access, profile, controller, serviceId, managementCapability,
    intentBinding, assertCurrent)
  const initialRequest = await verifyEnrollmentRequest(initialBody, access, profile, serviceId, managementCapability, intentBinding, Boolean(pending))
  assertExpectedPolicyRevision(expectedPolicyRevision, initialRequest)
  await assertCurrent()
  if (service.scopeEnrollmentRetry === 1) await prepareScopeEnrollmentIntent(intentBinding, initialBody, assertCurrent)
  await assertCurrent()
  const { body, request, receipt } = await submitRecoverableEnrollment({ body: initialBody, request: initialRequest,
    pending, intentBinding, assertCurrent, refresh: async () => {
      const body = await createEnrollmentRequest(access, profile, controller, serviceId, managementCapability, intentBinding, assertCurrent)
      return { body, request: await verifyEnrollmentRequest(body, access, profile, serviceId, managementCapability, intentBinding, false) }
    } })
  await assertCurrent()
  await verifyService(receipt, access, serviceId)
  await assertCurrent()
  const result = receipt.payload
  const authorizationHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(request.authorization)))
  if (!receiptCoversEnrollment(result, { serviceId, scopeId: access.scopeId, personId: profile.identity.personId,
    revision: request.authorization.payload.expectedRevision, revoked, challengeId: request.authorization.payload.challengeId,
    authorizationHash, minimumWriterVersion })) {
    throw new Error("Rusty receipt does not cover this connection")
  }
  await assertCurrent()
  await confirmed?.(structuredClone(receipt))
  await assertCurrent()
  if (service.scopeEnrollmentRetry === 1) await completeScopeEnrollmentIntent(intentBinding, body, assertCurrent)
  return result.revision
}

async function submitRecoverableEnrollment(input: { body: string; request: EnrollmentRequest; pending?: ScopeEnrollmentIntent;
  intentBinding: ScopeEnrollmentBinding; assertCurrent: () => Promise<void>;
  refresh: () => Promise<{ body: string; request: EnrollmentRequest }> }) {
  const submit = (body: string) => submitEnrollmentRequest(input.intentBinding.origin, input.intentBinding.scopeId, body, input.assertCurrent)
  try { return { body: input.body, request: input.request, receipt: await submit(input.body) } }
  catch (error) {
    if (!input.pending || !error || typeof error !== "object" || !("status" in error) || error.status !== 410) throw error
    await input.assertCurrent()
    const fresh = await input.refresh()
    if (fresh.request.challenge.payload.expectedRevision !== input.request.challenge.payload.expectedRevision ||
        fresh.request.challenge.payload.issuedAt < input.request.challenge.payload.expiresAt)
      throw new Error("Rusty enrollment outcome is unresolved; original request retained for recovery", { cause: error })
    await input.assertCurrent()
    await replaceScopeEnrollmentIntent(input.intentBinding, input.body, fresh.body, input.assertCurrent)
    return { ...fresh, receipt: await submit(fresh.body) }
  }
}

async function submitEnrollmentRequest(origin: string, scopeId: string, body: string, assertCurrent: () => Promise<void>) {
  await assertCurrent()
  const response = await fetchBlind(`${origin}/v2/scopes/${scopeId}`, {
    method: "PUT", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" }, body,
  })
  await assertCurrent()
  const result = await readBlindJson<{ receipt: SignedEnvelope<PolicyReceipt> }>(response, 65536)
  await assertCurrent()
  return result.receipt
}

async function createEnrollmentRequest(access: BlindAccess, profile: LocalProfile,
  controller: Pick<EnrollmentRequest, "identity" | "deviceId" | "certificates">, serviceId: string,
  managementCapability: SignedEnvelope<RustyManagementCapability> | undefined, intent: ScopeEnrollmentBinding,
  assertCurrent: () => Promise<void>): Promise<string> {
  const publicOrigin = intent.origin
  const minimumWriterVersion = intent.minimumWriterVersion
  const management = managementCapability ? { managementCapability } : {}
  const binding = { origin: publicOrigin, servicePublicKey: access.servicePublicKey, resourceKind: "scope" as const, resourceId: access.scopeId }
  const challengeResponse = await fetchBlind(`${publicOrigin}/v2/enrollment/challenge`, {
    method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, scopeId: access.scopeId, ...controller, ...management }),
  })
  await assertCurrent()
  const { challenge } = await readBlindJson<{ challenge: SignedEnvelope<Challenge> }>(challengeResponse, 65536)
  await assertCurrent()
  await verifyService(challenge, access, serviceId)
  validateChallenge(challenge.payload, access, profile, serviceId)
  const { expectedRevision, challengeId, nonce, expiresAt } = challenge.payload
  const context = await resolveLocalSigningContext(profile, "rusty-scope-enrollment", {
    scopeId: access.scopeId, publicOrigin, serviceId, personId: profile.identity.personId,
    deviceId: profile.device.deviceId, challengeId, nonce,
    ...(minimumWriterVersion === undefined ? {} : { minimumWriterVersion }),
  }, { certificates: controller.certificates, expiresAt, ensureCurrent: assertCurrent,
    currentAuthority: rustyManagementAuthorityRevision(binding, profile, "scope.policy", managementCapability) })
  await assertCurrent()
  const authorization = await signWithContext(context, {
    kind: "rusty-scope-enrollment", version: 1, challengeId, nonce, serviceId, publicOrigin, scopeId: access.scopeId,
    personId: profile.identity.personId, deviceId: profile.device.deviceId, deviceKeyId: profile.device.deviceId, expectedRevision,
    readTokenHash: intent.readTokenHash, writeTokenHash: intent.writeTokenHash, revoked: intent.revoked, expiresAt,
    ...(minimumWriterVersion === undefined ? {} : { minimumWriterVersion }),
    ...(managementCapability ? { managementRevision: managementCapability.payload.revision } : {}),
  })
  await assertCurrent()
  return JSON.stringify({ challenge, ...controller, ...management, readToken: access.readToken, writeToken: access.writeToken,
    revoked: intent.revoked, authorization })
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
    "deviceKeyId", "expectedRevision", "readTokenHash", "writeTokenHash", "revoked", "expiresAt"], ["minimumWriterVersion", "managementRevision"])
  assertEnrollmentConnection(request, access, profile, intent, managementCapability)
  await verifyService(request.challenge, access, serviceId)
  validateChallenge(request.challenge.payload, access, profile, serviceId, allowExpired)
  const challenge = request.challenge.payload
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
    minimumWriterVersion: intent.minimumWriterVersion, managementRevision: managementCapability?.payload.revision }
  if (signerKeyId !== intent.deviceId || Object.entries(expected).some(([key, value]) => proof[key as keyof EnrollmentAuthorization] !== value))
    throw new Error("Saved Rusty enrollment authorization binding invalid")
}

function receiptCoversEnrollment(receipt: PolicyReceipt, expected: { serviceId: string; scopeId: string; personId: string;
  revision: number; revoked: boolean; challengeId: string; authorizationHash: string; minimumWriterVersion?: 2 }): boolean {
  const revisionMatches = receipt.revision === expected.revision + 1 ||
    (expected.minimumWriterVersion === 2 && receipt.revision === expected.revision)
  const writerVersionMatches = expected.minimumWriterVersion === 2
    ? receipt.minimumWriterVersion === 2
    : !Object.hasOwn(receipt, "minimumWriterVersion") || receipt.minimumWriterVersion === 2
  return receipt.kind === "rusty-scope-policy-receipt" && receipt.version === 1 && receipt.serviceId === expected.serviceId &&
    receipt.scopeId === expected.scopeId && receipt.personId === expected.personId && revisionMatches &&
    receipt.revoked === expected.revoked && receipt.challengeId === expected.challengeId &&
    receipt.authorizationHash === expected.authorizationHash && writerVersionMatches
}

/** Retained transition evidence must bind the exact original token request, not merely a valid scope receipt. */
export async function verifySavedScopeEnrollmentConfirmation(access: BlindAccess, profile: LocalProfile,
  saved: ScopeEnrollmentIntent, value: unknown): Promise<RustyScopePolicyReceipt> {
  access = structuredClone(access)
  profile = structuredClone(profile)
  saved = structuredClone(saved)
  const receipt = parseRustyScopePolicyReceipt(value)
  const serviceId = await blindHash(decodeBlindBytes(access.servicePublicKey))
  const expected: ScopeEnrollmentBinding = { origin: blindOrigin(access.origin), scopeId: access.scopeId,
    servicePublicKey: access.servicePublicKey, personId: profile.identity.personId, deviceId: profile.device.deviceId,
    readTokenHash: await sha256Base64Url(new TextEncoder().encode(access.readToken)),
    writeTokenHash: await sha256Base64Url(new TextEncoder().encode(access.writeToken)), revoked: false,
    ...(saved.binding.minimumWriterVersion === 2 ? { minimumWriterVersion: 2 } : {}) }
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
    minimumWriterVersion: expected.minimumWriterVersion })) throw new Error("Retained scope receipt does not confirm the original credential request")
  return receipt
}
