import type { LocalProfile } from "../domain/identity"
import { discoverBlindKeeper } from "./blindClient"
import { ensureIdentityReplicaConnection } from "./identityReplicaConnection"
import { assertReplicaCredentialsUnfrozen } from "./replicaCredentialFreeze"

/** Bind profile setup to an already pinned connection, without forwarding any board credentials. */
export async function provisionIdentityReplica(access: { origin: string; servicePublicKey: string },
  profile: LocalProfile, ensureCurrent: () => void) {
  const pin = { origin: access.origin, servicePublicKey: access.servicePublicKey }
  ensureCurrent()
  await assertReplicaCredentialsUnfrozen(profile.identity.personId, pin)
  ensureCurrent()
  const service = await discoverBlindKeeper(pin.origin)
  ensureCurrent()
  await assertReplicaCredentialsUnfrozen(profile.identity.personId, pin)
  ensureCurrent()
  if (service.servicePublicKey !== pin.servicePublicKey) throw new Error("Profile setup service pin changed")
  return ensureIdentityReplicaConnection(service, profile, ensureCurrent)
}
