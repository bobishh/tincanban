import { canonicalizeJson, sha256Base64Url, signEnvelope, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import { certHashDefault, defaultProofStore } from "../domain/proofs"
import type { DeviceCertificate } from "../domain/model"
import { blindHash, blindOrigin, fetchBlind, readBlindJson, type BlindAccess } from "./blindClient"
import { decodeBlindBytes } from "./blindEnvelope"

type Challenge = {
  kind: "rusty-enrollment-challenge"; version: 1; challengeId: string; nonce: string; serviceId: string;
  publicOrigin: string; scopeId: string; personId: string; deviceId: string; deviceKeyId: string;
  expectedRevision: number; issuedAt: number; expiresAt: number;
}
type PolicyReceipt = {
  kind: "rusty-scope-policy-receipt"; version: 1; serviceId: string; scopeId: string; personId: string;
  revision: number; revoked: boolean; challengeId: string; authorizationHash: string;
}

export async function rustyCertificateChain(profile: LocalProfile): Promise<DeviceCertificate[]> {
  const pool = await defaultProofStore.listCertificates()
  const byHash = new Map(await Promise.all(pool.map(async cert => [await certHashDefault(cert), cert] as const)))
  const chain: DeviceCertificate[] = []
  let current: DeviceCertificate | undefined = profile.certificate
  while (current) {
    if (chain.length >= 32 || chain.some(cert => cert.signature === current?.signature)) throw new Error("Device certificate chain invalid")
    chain.push(current)
    const issuer: string | null = current.payload.issuerCertificateHash
    if (issuer === null) return chain
    current = byHash.get(issuer)
  }
  throw new Error("Device certificate chain incomplete")
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
export async function approveRustyScope(access: BlindAccess, profile: LocalProfile, revoked = false): Promise<number> {
  const publicOrigin = blindOrigin(access.origin)
  const serviceId = await blindHash(decodeBlindBytes(access.servicePublicKey))
  const controller = { identity: profile.identity, deviceId: profile.device.deviceId, certificates: await rustyCertificateChain(profile) }
  const { challenge } = await readBlindJson<{ challenge: SignedEnvelope<Challenge> }>(await fetchBlind(`${publicOrigin}/v2/enrollment/challenge`, {
    method: "POST", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, scopeId: access.scopeId, ...controller }),
  }), 65536)
  await verifyService(challenge, access, serviceId)
  validateChallenge(challenge.payload, access, profile, serviceId)
  const { expectedRevision, challengeId, nonce, expiresAt } = challenge.payload
  const authorization = await signEnvelope(profile.privateKeys.devicePrivateKey, {
    kind: "rusty-scope-enrollment", version: 1, challengeId, nonce, serviceId, publicOrigin, scopeId: access.scopeId,
    personId: profile.identity.personId, deviceId: profile.device.deviceId, deviceKeyId: profile.device.deviceId, expectedRevision,
    readTokenHash: await sha256Base64Url(new TextEncoder().encode(access.readToken)),
    writeTokenHash: await sha256Base64Url(new TextEncoder().encode(access.writeToken)), revoked, expiresAt,
  }, profile.device.deviceId)
  const { receipt } = await readBlindJson<{ receipt: SignedEnvelope<PolicyReceipt> }>(await fetchBlind(`${publicOrigin}/v2/scopes/${access.scopeId}`, {
    method: "PUT", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge, ...controller, readToken: access.readToken, writeToken: access.writeToken, revoked, authorization }),
  }), 65536)
  await verifyService(receipt, access, serviceId)
  const result = receipt.payload
  const authorizationHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(authorization)))
  if (result.kind !== "rusty-scope-policy-receipt" || result.version !== 1 || result.serviceId !== serviceId || result.scopeId !== access.scopeId ||
    result.personId !== profile.identity.personId || result.revision !== expectedRevision + 1 || result.revoked !== revoked ||
    result.challengeId !== challengeId || result.authorizationHash !== authorizationHash) throw new Error("Rusty receipt does not cover this connection")
  return result.revision
}
