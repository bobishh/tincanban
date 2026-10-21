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

/** Board setup is separate from the loop that schedules workspace and private identity replicas. */
export async function connectWorkspaceReplica(app: ReturnType<typeof useTincanban>, origin: string,
  workspaceId: string, ensureCurrent: () => void): Promise<void> {
  ensureCurrent()
  const profile = app.getCurrentProfile()
  const owner = profile?.identity.personId
  if (!owner || !profile) throw new Error("Identity unavailable")
  await assertReplicaCredentialsUnfrozen(owner, { origin })
  ensureCurrent()
  const doc = await app.readWorkspaceDoc(workspaceId)
  if (!owner || doc.ownerPersonId !== owner) throw new Error("Only the workspace owner can configure Rusty")
  const service = await discoverBlindKeeper(origin)
  ensureCurrent()
  const current = app.getCurrentProfile()
  if (!current || current.identity.personId !== owner || current.device.deviceId !== profile.device.deviceId) throw new Error("Identity unavailable")
  await ensureWorkspaceReplicaConnection(service, workspaceId, current, ensureCurrent, { allowNewScopeAfterRemoval: true,
    beforeSetup: async () => {
      ensureCurrent()
      await ensureRustyPersonPolicy(service, current, service.personManagement === 1, { ensureCurrent, allowLegacyMigration: true })
      ensureCurrent()
    } })
  ensureCurrent()
  const { ensureIdentityReplicaConnection } = await import("./identityReplicaConnection")
  await ensureIdentityReplicaConnection(service, current, ensureCurrent, { allowNewScopeAfterRemoval: true })
  ensureCurrent()
}

/** Retain a pending connection until Rusty confirms revocation; private identity scopes are independent. */
export async function revokeWorkspaceReplicaConnection(config: BlindReplicaConfig, profile: LocalProfile,
  ensureCurrent: () => void): Promise<BlindReplicaConfig[]> {
  ensureCurrent()
  if (config.boardAccess) throw new Error("Only the board owner can remove its Rusty connection")
  await approveRustyScope(config, profile, true)
  ensureCurrent()
  await recordReplicaPreference(profile.identity.personId, config, true)
  ensureCurrent()
  return getReplicaConfigurations(profile.identity.personId)
}
