import { captureIdentityProfile } from "../domain/identity"
import { bootstrapIdentity, type LocalProfile } from "../domain/identity"
import { getReplicaConfigurations } from "./privateReplicaRepository"
import { readReplicaCredentialFreeze } from "./replicaCredentialFreeze"
import { RustyManagementRepository } from "./rustyManagementRepository"

export class PrivateIdentityExchangeDeniedError extends Error {
  constructor(message: string) { super(message); this.name = "PrivateIdentityExchangeDeniedError" }
}

/** Recheck live identity, signed Rusty revocations and in-flight transition targets before private state crosses devices. */
export async function assertIdentityDevicePrivateExchangeAllowed(profile: LocalProfile, remoteDeviceId: string,
  ensureCurrent: () => void = () => {}): Promise<void> {
  profile = captureIdentityProfile(profile)
  if (!remoteDeviceId || remoteDeviceId.length > 128) throw new Error("Invalid remote identity device")
  ensureCurrent()
  const current = await bootstrapIdentity()
  ensureCurrent()
  if (current.identity.personId !== profile.identity.personId || current.identity.publicKey !== profile.identity.publicKey ||
    current.device.deviceId !== profile.device.deviceId || current.device.publicKey !== profile.device.publicKey ||
    current.certificate.signature !== profile.certificate.signature) throw new Error("Identity changed during private device exchange")

  const [configurations, policies] = await Promise.all([
    getReplicaConfigurations(profile.identity.personId),
    new RustyManagementRepository(profile.identity.personId).export(),
  ])
  ensureCurrent()
  if (policies.some(({ binding, capability }) => (binding.resourceKind === "person" || binding.resourceKind === "scope") &&
    (capability.payload.revokedDeviceIds.includes(remoteDeviceId) || capability.payload.revokedDeviceIds.includes(profile.device.deviceId)))) {
    throw new PrivateIdentityExchangeDeniedError("Rusty policy revoked a device from private identity exchange")
  }

  const origins = new Set([...configurations.map(config => config.origin), ...policies
    .filter(({ binding }) => binding.resourceKind === "person" || binding.resourceKind === "scope")
    .map(({ binding }) => binding.origin)])
  for (const origin of origins) {
    ensureCurrent()
    const freeze = await readReplicaCredentialFreeze(profile.identity.personId, origin)
    ensureCurrent()
    if (freeze && "revokedDeviceId" in freeze && freeze.revokedDeviceId === remoteDeviceId) {
      throw new PrivateIdentityExchangeDeniedError("Rusty credential transition is revoking this device")
    }
  }
}
