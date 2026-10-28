import { identityProfileRustyServicePins } from "@meta-uber/mesh-identity"
import type { useTincanban } from "../state"
import { defaultStorage } from "../storage"
import { rootIdentityProfileState } from "../domain/identityProfileRoot"
import { getIdentityReplicaConfigurations, getReplicaConfigurations } from "../sync/privateReplicaRepository"
import { connectWorkspaceReplica } from "../sync/replicaConnections"
import { createBlindReplica } from "../sync/blindReplicaStore"
import { createIdentityReplica } from "../sync/identityReplicaStore"

type App = ReturnType<typeof useTincanban>

/** Ownership admission is durable already; derive unfinished delivery from that fact after a restart. */
export async function connectAdoptedIdentityBoards(app: App, guard: () => void): Promise<void> {
  const profile = app.getCurrentProfile()
  if (!profile) throw new Error("Identity unavailable while connecting added boards")
  const root = await defaultStorage.loadPersonalRoot()
  if (!root || root.identity.personId !== profile.identity.personId) throw new Error("Added-board catalog is unavailable")
  const pins = identityProfileRustyServicePins(await rootIdentityProfileState(root))
  const origins = new Set<string>()
  for (const reference of Object.values(root.workspaces)) {
    if (reference.forgotten) continue
    guard()
    const ownerPersonId = await app.withWorkspaceDoc(reference.workspaceId, document => document.ownerPersonId).catch(() => null)
    if (!ownerPersonId || ownerPersonId === profile.identity.personId) continue
    if (await app.getWorkspaceRole(reference.workspaceId) !== "owner") continue
    for (const pin of pins) {
      guard()
      await connectWorkspaceReplica(app, pin.origin, reference.workspaceId, guard, { allowNewScopeAfterRemoval: false })
      const config = (await getReplicaConfigurations(profile.identity.personId)).find(value =>
        value.workspaceId === reference.workspaceId && value.origin === pin.origin)
      if (!config) throw new Error("Added board connection is pending; retry sign-in")
      await createBlindReplica(config, app, guard, async () => {}).push()
      origins.add(pin.origin)
    }
  }
  await publishAddedBoardCatalog(profile, origins, guard)
}

async function publishAddedBoardCatalog(profile: NonNullable<ReturnType<App["getCurrentProfile"]>>,
  origins: Set<string>, guard: () => void): Promise<void> {
  for (const config of await getIdentityReplicaConfigurations(profile.identity.personId)) {
    if (!origins.has(config.origin)) continue
    guard()
    const replica = createIdentityReplica(config, profile, guard, { includeRecoveryEvidence: false })
    if (!await replica.sync() && !await replica.sync()) throw new Error("Added-board catalog delivery remains pending; retry sign-in")
  }
}
