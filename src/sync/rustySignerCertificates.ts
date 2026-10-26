import { identityDeviceCertificateChain } from "@meta-uber/mesh-identity"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { requireIdentityAuthorityView } from "./identityAuthorityStore"

/** Return the active device's verified chain in Rusty's leaf-to-root wire order. */
export async function rustySignerCertificateChain(profile: LocalProfile) {
  const identity = structuredClone(profile.identity)
  const view = await requireIdentityAuthorityView(identity.personId)
  if (view.identityPublicKey !== identity.publicKey) throw new Error("Rusty signer authority belongs to another Identity")
  const chain = await identityDeviceCertificateChain(identity,
    { certificates: view.certificates, revocations: view.revocations }, profile.device.deviceId)
  if (canonicalizeJson(chain[0] ?? null) !== canonicalizeJson(profile.certificate)) {
    throw new Error("Rusty signer certificate does not match the active device")
  }
  return chain
}
