import { canonicalizeJson, sha256Base64Url, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { signingEvidence, signWithContext } from "../domain/signingContext"
import type { DeviceCertificate } from "../domain/model"
import { blindHash, blindOrigin, discoverBlindKeeper, fetchBlind, readBlindJson, type BlindAccess } from "./blindClient"
import { decodeBlindBytes } from "./blindEnvelope"
import { resolveRustyManagementAuthority, rustyManagementAuthorityRevision } from "./rustyManagementClient"
import type { RustyScopePolicyReceipt } from "./rustyScopePolicy"

type Challenge = {
  kind: "rusty-enrollment-challenge"; version: 1; challengeId: string; nonce: string; serviceId: string;
  publicOrigin: string; scopeId: string; personId: string; deviceId: string; deviceKeyId: string;
  expectedRevision: number; issuedAt: number; expiresAt: number;
}
type PolicyReceipt = {
  kind: "rusty-scope-policy-receipt"; version: 1; serviceId: string; scopeId: string; personId: string;
  revision: number; revoked: boolean; challengeId: string; authorizationHash: string; minimumWriterVersion?: 2;
}

export type RustyScopeEnrollmentOptions = { minimumWriterVersion?: 2; ensureCurrent?: () => void | Promise<void>;
  confirmed?: (receipt: RustyScopePolicyReceipt) => void | Promise<void> }

async function rustyCertificateChain(profile: LocalProfile, ensureCurrent: () => Promise<void>): Promise<DeviceCertificate[]> {
  const context = await resolveLocalSigningContext(profile, "rusty-controller-proof", { personId: profile.identity.personId }, { ensureCurrent })
  await ensureCurrent()
  return signingEvidence(context).certificates
}

async function verifyService<T extends { kind: string }>(value: SignedEnvelope<T>, access: BlindAccess, serviceId: string) {
  if (!value?.payload || value.signerKeyId !== serviceId || !await verifyEnvelope(value, access.servicePublicKey, "RUSTY/2")) {
    throw new Error("Rusty signature invalid")
  }
}

function validateChallenge(payload: Challenge, access: BlindAccess, profile: LocalProfile, serviceId: string) {
  const now = Date.now()
  if (payload.kind !== "rusty-enrollment-challenge" || payload.version !== 1 || payload.serviceId !== serviceId ||
    payload.publicOrigin !== blindOrigin(access.origin) || payload.scopeId !== access.scopeId || payload.personId !== profile.identity.personId ||
    payload.deviceId !== profile.device.deviceId || payload.deviceKeyId !== profile.device.deviceId || !payload.challengeId || !payload.nonce ||
    !validChallengeTiming(payload, now)) throw new Error("Rusty challenge does not cover this connection")
}

function validChallengeTiming(payload: Challenge, now: number): boolean {
  return Number.isSafeInteger(payload.expectedRevision) && payload.expectedRevision >= 0 && Number.isSafeInteger(payload.issuedAt) &&
    Number.isSafeInteger(payload.expiresAt) && payload.issuedAt <= now + 5000 && payload.expiresAt > now &&
    payload.expiresAt - payload.issuedAt <= 120000 && payload.expiresAt > payload.issuedAt
}

/** Public identity evidence and scoped storage credentials leave the browser; content keys stay local. */
export async function approveRustyScope(access: BlindAccess, profile: LocalProfile, revoked = false,
  options: RustyScopeEnrollmentOptions = {}): Promise<number> {
  const ensureCurrentOption = options.ensureCurrent
  const confirmed = options.confirmed
  const assertCurrent = async () => { await ensureCurrentOption?.() }
  const minimumWriterVersion = options.minimumWriterVersion
  access = { ...access }
  profile = structuredClone(profile)
  if (minimumWriterVersion !== undefined && minimumWriterVersion !== 2) throw new Error("Unsupported Rusty writer version")
  await assertCurrent()
  const publicOrigin = blindOrigin(access.origin)
  const serviceId = await blindHash(decodeBlindBytes(access.servicePublicKey))
  await assertCurrent()
  const controller = { identity: profile.identity, deviceId: profile.device.deviceId,
    certificates: await rustyCertificateChain(profile, assertCurrent) }
  await assertCurrent()
  const service = await discoverBlindKeeper(publicOrigin)
  await assertCurrent()
  if (service.servicePublicKey !== access.servicePublicKey) throw new Error("Rusty management service pin changed")
  if (minimumWriterVersion === 2 && service.writerPolicy?.maximumWriterVersion !== 2) {
    throw new Error("Rusty service does not advertise the requested writer policy")
  }
  const binding = { origin: publicOrigin, servicePublicKey: access.servicePublicKey, resourceKind: "scope" as const, resourceId: access.scopeId }
  const managementCapability = await resolveRustyManagementAuthority(binding, profile, "scope.policy", service.scopeManagement === 1)
  await assertCurrent()
  const management = managementCapability ? { managementCapability } : {}
  await assertCurrent()
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
    readTokenHash: await sha256Base64Url(new TextEncoder().encode(access.readToken)),
    writeTokenHash: await sha256Base64Url(new TextEncoder().encode(access.writeToken)), revoked, expiresAt,
    ...(minimumWriterVersion === undefined ? {} : { minimumWriterVersion }),
    ...(managementCapability ? { managementRevision: managementCapability.payload.revision } : {}),
  })
  await assertCurrent()
  const receiptResponse = await fetchBlind(`${publicOrigin}/v2/scopes/${access.scopeId}`, {
    method: "PUT", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge, ...controller, ...management, readToken: access.readToken, writeToken: access.writeToken, revoked, authorization }),
  })
  await assertCurrent()
  const { receipt } = await readBlindJson<{ receipt: SignedEnvelope<PolicyReceipt> }>(receiptResponse, 65536)
  await assertCurrent()
  await verifyService(receipt, access, serviceId)
  await assertCurrent()
  const result = receipt.payload
  const authorizationHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(authorization)))
  if (!receiptCoversEnrollment(result, { serviceId, scopeId: access.scopeId, personId: profile.identity.personId,
    revision: expectedRevision + 1, revoked, challengeId, authorizationHash, minimumWriterVersion })) {
    throw new Error("Rusty receipt does not cover this connection")
  }
  await assertCurrent()
  await confirmed?.(structuredClone(receipt))
  await assertCurrent()
  return result.revision
}

function receiptCoversEnrollment(receipt: PolicyReceipt, expected: { serviceId: string; scopeId: string; personId: string;
  revision: number; revoked: boolean; challengeId: string; authorizationHash: string; minimumWriterVersion?: 2 }): boolean {
  const writerVersionMatches = expected.minimumWriterVersion === 2
    ? receipt.minimumWriterVersion === 2
    : !Object.hasOwn(receipt, "minimumWriterVersion") || receipt.minimumWriterVersion === 2
  return receipt.kind === "rusty-scope-policy-receipt" && receipt.version === 1 && receipt.serviceId === expected.serviceId &&
    receipt.scopeId === expected.scopeId && receipt.personId === expected.personId && receipt.revision === expected.revision &&
    receipt.revoked === expected.revoked && receipt.challengeId === expected.challengeId &&
    receipt.authorizationHash === expected.authorizationHash && writerVersionMatches
}
