import { captureIdentityProfile, isCurrentIdentityProfile, sha256Base64Url, type LocalProfile } from "../domain/identity"
import type { DeviceCertificate } from "../domain/model"
import { resolveSigningContext, signingEvidence, signWithContext } from "../domain/signingContext"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { fetchBlind, readBlindJson } from "./rustyHttp"
import type { ManagementConflictResolver } from "./rustyManagementReconciliation"
import type { ManagementStatusAuthorization, RustyManagementStatusResponse } from "./rustyManagementStatus"
import type { Context } from "@opentelemetry/api"

/** The approved certificate allows reading current status before adopting the returning device's identity. */
export function enrollmentManagementConflictResolver(prepared: { profile: LocalProfile; certificates: DeviceCertificate[] },
  original: LocalProfile, ensureCurrent: () => void, diagnosticContext?: Context): ManagementConflictResolver {
  const profile = captureIdentityProfile(prepared.profile)
  const certificates = structuredClone(prepared.certificates)
  const assertCurrent = () => {
    ensureCurrent()
    if (!isCurrentIdentityProfile(original)) throw new Error("Identity changed during device enrollment")
  }
  return async binding => {
    assertCurrent()
    const issuedAt = Date.now(), expiresAt = issuedAt + 120_000
    const serviceId = await sha256Base64Url(decodeBlindBytes(binding.servicePublicKey))
    const scope = { serviceId, origin: binding.origin, personId: profile.identity.personId,
      deviceId: profile.device.deviceId, resourceKind: binding.resourceKind, resourceId: binding.resourceId }
    const authorityRevision = profile.certificate.signature
    const signing = await resolveSigningContext({ profile, certificates, purpose: "rusty-management-policy-status",
      binding: scope, authorityRevision, expiresAt, current: async () => {
        assertCurrent()
        return { personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision }
      } })
    const authorization = await signWithContext(signing, { kind: "rusty-management-policy-status", version: 1,
      ...scope, requestId: crypto.randomUUID(), issuedAt, expiresAt } satisfies ManagementStatusAuthorization)
    const evidence = signingEvidence(signing)
    assertCurrent()
    const response = await readBlindJson<RustyManagementStatusResponse>(await fetchBlind(
      `${binding.origin}/v2/management/${binding.resourceKind}/${binding.resourceId}/status`, {
        method: "POST", cache: "no-store", signal: AbortSignal.timeout(15_000), headers: { "Content-Type": "application/json" },
        diagnosticContext,
        body: JSON.stringify({ version: 1, identity: evidence.identity, deviceId: profile.device.deviceId,
          certificates: evidence.certificates, authorization }),
      }), 1024 * 1024)
    assertCurrent()
    return { deviceId: profile.device.deviceId, authorization, response }
  }
}
