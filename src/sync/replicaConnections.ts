import type { useTincanban } from "../state"
import type { BlindReplicaConfig } from "./blindReplication"
import { discoverBlindKeeper } from "./blindClient"
import { getReplicaConfigurations } from "./privateReplicaRepository"
import { approveRustyScope } from "./rustyEnrollment"
import { recordReplicaPreference } from "./identityDevicePreferences"
import { ensureRustyPersonPolicy } from "./rustyManagementClient"
import { ensureWorkspaceReplicaConnection } from "./workspaceReplicaConnection"
import type { LocalProfile } from "../domain/identity"
import { assertReplicaCredentialsUnfrozen } from "./replicaCredentialFreeze"
import { requireIdentityAuthorityView } from "./identityAuthorityStore"
import { readIdentityRustyServicePin } from "./identityRustyServiceCatalog"
import { retainHistoryForReplicaDisconnect } from "./historyBaselineStartup"
import { registerLocalWorkspaceOwners } from "./localWorkspaceOwnerRegistration"

/** Board setup is separate from the loop that schedules workspace and private identity replicas. */
export async function connectWorkspaceReplica(app: ReturnType<typeof useTincanban>, origin: string,
  workspaceId: string, ensureCurrent: () => void, options: { allowNewScopeAfterRemoval?: boolean } = {}): Promise<void> {
  ensureCurrent()
  const profile = app.getCurrentProfile()
  const owner = profile?.identity.personId
  if (!owner || !profile) throw new Error("Identity unavailable")
  await assertReplicaCredentialsUnfrozen(owner, { origin })
  ensureCurrent()
  if (await app.getWorkspaceRole(workspaceId) !== "owner") throw new Error("Only the workspace owner can configure Rusty")
  const service = await discoverBlindKeeper(origin)
  await requireIdentityAuthorityView(profile.identity.personId)
  const servicePin = await readIdentityRustyServicePin(profile.identity.personId, service.origin, profile)
  if (servicePin && (servicePin.servicePublicKey !== service.servicePublicKey ||
      servicePin.serviceId !== service.serviceId)) throw new Error("Rusty service key changed after Identity approval")
  if (!servicePin) throw new Error("Approve this Rusty service key in Identity before connecting it")
  ensureCurrent()
  const current = app.getCurrentProfile()
  if (!current || current.identity.personId !== owner || current.device.deviceId !== profile.device.deviceId) throw new Error("Identity unavailable")
  const { ensureIdentityReplicaConnection } = await import("./identityReplicaConnection")
  await ensureIdentityReplicaConnection(service, current, ensureCurrent, { allowNewScopeAfterRemoval: options.allowNewScopeAfterRemoval ?? true })
  ensureCurrent()
  const config = await ensureWorkspaceReplicaConnection(service, workspaceId, current, ensureCurrent, { allowNewScopeAfterRemoval: options.allowNewScopeAfterRemoval ?? true,
    beforeSetup: async () => {
      ensureCurrent()
      await ensureRustyPersonPolicy(service, current, service.personManagement === 1, { ensureCurrent, allowLegacyMigration: true })
      ensureCurrent()
    } })
  await registerLocalWorkspaceOwners(current, config, ensureCurrent)
  ensureCurrent()
}

/** Retain a pending connection until Rusty confirms revocation; private identity scopes are independent. */
export async function revokeWorkspaceReplicaConnection(config: BlindReplicaConfig, profile: LocalProfile,
  ensureCurrent: () => void): Promise<BlindReplicaConfig[]> {
  ensureCurrent()
  if (config.boardAccess) throw new Error("Only the board owner can remove its Rusty connection")
  await retainHistoryForReplicaDisconnect(config, profile.identity.personId, ensureCurrent)
  ensureCurrent()
  await approveRustyScope(config, profile, true, { scopePurpose: "workspace" })
  ensureCurrent()
  await recordReplicaPreference(profile.identity.personId, config, true)
  ensureCurrent()
  return getReplicaConfigurations(profile.identity.personId)
}
