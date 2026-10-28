import { captureIdentityProfile, isCurrentIdentityProfile, type LocalProfile } from "../domain/identity"
import type { DeviceCertificate } from "../domain/model"
import { resolveSigningContext, signWithContext } from "../domain/signingContext"
import { fetchBlind } from "./rustyHttp"
import type { ManagementConflictResolver } from "./rustyManagementReconciliation"
import { requestRustyManagementStatus } from "@meta-uber/mesh-replication/rusty-management"
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
  return async (binding, minimumRevision) => {
    assertCurrent()
    const { authorization, response } = await requestRustyManagementStatus({ binding, identity: profile.identity,
      deviceId: profile.device.deviceId, devicePublicKey: profile.device.publicKey, certificates, minimumRevision,
      ensureCurrent: assertCurrent,
      fetcher: (input, init) => fetchBlind(String(input), { ...init, diagnosticContext }),
      signAuthorization: async payload => {
        const { serviceId, origin, personId, deviceId, resourceKind, resourceId } = payload
        const authorityRevision = profile.certificate.signature
        const signing = await resolveSigningContext({ profile, certificates, purpose: payload.kind,
          binding: { serviceId, origin, personId, deviceId, resourceKind, resourceId }, authorityRevision, expiresAt: payload.expiresAt,
          current: async () => { assertCurrent(); return { personId: profile.identity.personId,
            deviceId: profile.device.deviceId, authorityRevision } } })
        return signWithContext(signing, payload)
      },
    })
    return { deviceId: profile.device.deviceId, authorization, response }
  }
}
