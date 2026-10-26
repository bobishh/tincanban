import { authorizeIdentityDataDevice, type PublicIdentity } from "@meta-uber/mesh-identity"
import { publishRustyIdentityAuthorityView, readRustyIdentityAuthorityStatus } from "@meta-uber/mesh-replication/rusty-identity-authority"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { signWithContext } from "../domain/signingContext"
import { peerStore } from "./peerStore"
import { requireIdentityAuthorityView } from "./identityAuthorityStore"
import type { BlindReplicaConfig } from "./blindReplication"

type ScopeOwner = { personId: string; publicKey: string }

/** Explicit connection registers previous local owners before publishing their signed control transfers. */
export async function registerLocalWorkspaceOwners(profile: LocalProfile, config: BlindReplicaConfig,
  ensureCurrent: () => void): Promise<void> {
  const authority = await peerStore.getWorkspaceAuthority(config.workspaceId)
  ensureCurrent()
  if (!authority?.scopeAuthoritySnapshot) throw new Error("Workspace ownership history is unavailable")
  const snapshot = authority.scopeAuthoritySnapshot
  const view = meshRustRuntime().state.validateScopeAuthority(snapshot, Date.now()) as { creator: ScopeOwner; controller: ScopeOwner }
  if (view.controller.personId !== profile.identity.personId || view.controller.publicKey !== profile.identity.publicKey) {
    throw new Error("Current Identity does not control the connected workspace")
  }
  const previous = [view.creator, ...snapshot.controlTransfers.map(record =>
    (record as { payload: { toController: ScopeOwner } }).payload.toController)]
  const owners = new Map(previous.filter(owner => owner.personId !== profile.identity.personId).map(owner => [owner.personId, owner]))
  for (const owner of owners.values()) await registerMissingLocalOwner(profile, config, owner, ensureCurrent)
}

async function registerMissingLocalOwner(profile: LocalProfile, config: BlindReplicaConfig, owner: ScopeOwner,
  ensureCurrent: () => void): Promise<void> {
  const identity: PublicIdentity = { ...owner, displayName: "" }
  const status = await readRustyIdentityAuthorityStatus({ ...config, identity })
  ensureCurrent()
  if (status.payload.state === "ready") return
  const view = await requireIdentityAuthorityView(owner.personId)
  if (view.identityPublicKey !== owner.publicKey ||
      await authorizeIdentityDataDevice(view, profile.device.deviceId) !== profile.device.publicKey) {
    throw new Error("The device that transferred this local board must finish its Rusty connection")
  }
  const guard = async () => {
    ensureCurrent()
    const latest = await requireIdentityAuthorityView(owner.personId)
    if (latest.viewDigest !== view.viewDigest) throw new Error("Previous local owner authority changed during Rusty connection")
    ensureCurrent()
  }
  await publishRustyIdentityAuthorityView({ ...config, identity, deviceId: profile.device.deviceId,
    devicePublicKey: profile.device.publicKey, view, ensureCurrent: guard,
    signAuthorization: async payload => {
      // The same app key remains certified by the previous local Identity.
      // Bind its use to this explicit connection and the currently active profile.
      const context = await resolveLocalSigningContext(profile, payload.kind, {
        origin: payload.origin, serviceId: payload.serviceId, personId: owner.personId,
        deviceId: profile.device.deviceId, viewDigest: view.viewDigest,
      }, { ensureCurrent: guard, currentAuthority: async () => {
        const current = await peerStore.getWorkspaceAuthority(config.workspaceId)
        if (current?.ownerPersonId !== profile.identity.personId || current.ownerPublicKey !== profile.identity.publicKey) {
          throw new Error("Workspace ownership changed during Rusty connection")
        }
        return canonicalizeJson(current.scopeAuthoritySnapshot)
      } })
      return signWithContext(context, payload)
    },
  })
}
