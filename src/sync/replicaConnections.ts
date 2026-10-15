import type { useTincanban } from "../state"
import { encodeBlindBytes } from "./blindEnvelope"
import type { BlindReplicaConfig } from "./blindReplication"
import { discoverBlindKeeper } from "./blindClient"
import { getReplicaConfigurations } from "./privateReplicaRepository"
import { approveRustyScope } from "./rustyEnrollment"
import { recordReplicaPreference } from "./identityDevicePreferences"
import { ensureRustyPersonPolicy } from "./rustyManagementClient"
import type { LocalProfile } from "../domain/identity"

/** Board setup is separate from the loop that schedules workspace and private identity replicas. */
export async function connectWorkspaceReplica(app: ReturnType<typeof useTincanban>, origin: string,
  workspaceId: string, ensureCurrent: () => void): Promise<void> {
  ensureCurrent()
  const owner = app.getCurrentProfile()?.identity.personId
  const doc = await app.readWorkspaceDoc(workspaceId)
  if (!owner || doc.ownerPersonId !== owner) throw new Error("Only the workspace owner can configure Rusty")
  const service = await discoverBlindKeeper(origin)
  const configs = await getReplicaConfigurations(owner)
  if (configs.some(config => config.origin === service.origin && config.workspaceId === workspaceId)) throw new Error("Rusty already connected to this board")
  const random = () => encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32)))
  const config: BlindReplicaConfig = { ...service, purpose: "workspace", workspaceId, scopeId: random(),
    readToken: random(), writeToken: random(), contentKey: random(), keyEpoch: 1, policyRevision: 1, cursor: 0, lastUploaded: "" }
  ensureCurrent()
  const profile = app.getCurrentProfile()
  if (!profile || profile.identity.personId !== owner) throw new Error("Identity unavailable")
  await ensureRustyPersonPolicy(service, profile, service.personManagement === 1, { ensureCurrent })
  config.policyRevision = await approveRustyScope(config, profile)
  ensureCurrent()
  await recordReplicaPreference(owner, config)
}

/** Retain a pending connection until Rusty confirms revocation; private identity scopes are independent. */
export async function revokeWorkspaceReplicaConnection(config: BlindReplicaConfig, profile: LocalProfile,
  ensureCurrent: () => void): Promise<BlindReplicaConfig[]> {
  ensureCurrent()
  await approveRustyScope(config, profile, true)
  ensureCurrent()
  await recordReplicaPreference(profile.identity.personId, config, true)
  ensureCurrent()
  return getReplicaConfigurations(profile.identity.personId)
}
