import { captureIdentityProfile } from "../domain/identity"
import { bootstrapIdentity, type LocalProfile } from "../domain/identity"
import { getReplicaConfigurations } from "./privateReplicaRepository"
import { readReplicaCredentialFreeze } from "./replicaCredentialFreeze"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { resolveLearnedIdentityAccess, IdentityDeviceAccessDeniedError } from "../domain/identityAuthority"

export class PrivateIdentityExchangeDeniedError extends Error {
  constructor(message: string, cause?: unknown) { super(message, { cause }); this.name = "PrivateIdentityExchangeDeniedError" }
}

function denyGlobalPrivateExchange(cause: unknown, profile: LocalProfile): never {
  if (!(cause instanceof IdentityDeviceAccessDeniedError)) throw cause
  throw new PrivateIdentityExchangeDeniedError(cause.deviceId === profile.device.deviceId
    ? "Local Identity device access is revoked or unavailable" : "Recipient Identity device access is revoked or unavailable", cause)
}

async function resolveGlobalPrivateExchange(profile: LocalProfile, remoteDeviceId: string): Promise<() => Promise<void>> {
  let assertGlobalCurrent: () => Promise<void>
  try { assertGlobalCurrent = await resolveLearnedIdentityAccess([
    { personId: profile.identity.personId, deviceId: profile.device.deviceId },
    { personId: profile.identity.personId, deviceId: remoteDeviceId },
  ]) } catch (cause) { denyGlobalPrivateExchange(cause, profile) }
  return async () => {
    try { await assertGlobalCurrent() } catch (cause) { denyGlobalPrivateExchange(cause, profile) }
  }
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

  const assertGlobalCurrent = await resolveGlobalPrivateExchange(profile, remoteDeviceId)
  ensureCurrent()

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
  await assertGlobalCurrent()
  ensureCurrent()
}
