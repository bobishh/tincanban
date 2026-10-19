import type { useTincanban } from "../state"
import { discoverBlindKeeper } from "./blindClient"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { getReplicaConfigurations } from "./privateReplicaRepository"
import { ensureRustyPersonPolicy, resolveRustyManagementAuthority } from "./rustyManagementClient"
import type { BlindReplicaConfig } from "./blindReplication"
import { privateReplicaBinding } from "./privateReplicaBinding"

/** Explicit legacy-policy adoption preserves the existing service/scope/credentials and never reissues device certificates. */
export async function migrateRustyDeviceAccess(app: Pick<ReturnType<typeof useTincanban>, "getCurrentProfile" | "readWorkspaceDoc">,
  origin: string, workspaceId: string, ensureCurrent: () => void): Promise<void> {
  origin = blindOrigin(origin)
  ensureCurrent()
  const initial = app.getCurrentProfile()
  if (!initial) throw new Error("Identity unavailable")
  const profile = { ...initial, identity: structuredClone(initial.identity), device: structuredClone(initial.device),
    certificate: structuredClone(initial.certificate), privateKeys: { ...initial.privateKeys } }
  const selection: { current?: BlindReplicaConfig } = {}
  const guardOwner = async () => {
    ensureCurrent()
    const doc = await app.readWorkspaceDoc(workspaceId)
    ensureCurrent()
    const active = app.getCurrentProfile()
    if (!active || active.identity.personId !== profile.identity.personId || active.device.deviceId !== profile.device.deviceId ||
      active.certificate.signature !== profile.certificate.signature || doc.ownerPersonId !== profile.identity.personId) {
      throw new Error("Only the current board owner can update Rusty device access")
    }
    const selected = selection.current
    if (selected) {
      const current = (await getReplicaConfigurations(profile.identity.personId))
        .find(config => config.origin === selected!.origin && config.scopeId === selected!.scopeId)
      ensureCurrent()
      if (!current || current.removalPending || privateReplicaBinding(profile.identity.personId, current) !==
        privateReplicaBinding(profile.identity.personId, selected)) throw new Error("Rusty connection changed during device-access update")
    }
  }
  await guardOwner()
  const matches = (await getReplicaConfigurations(profile.identity.personId))
    .filter(config => config.origin === origin && config.workspaceId === workspaceId && !config.removalPending)
  if (matches.length !== 1) throw new Error("Choose one current Rusty connection before updating device access")
  const config = matches[0]!
  selection.current = config
  const service = await discoverBlindKeeper(origin)
  await guardOwner()
  if (service.servicePublicKey !== config.servicePublicKey) throw new Error("Rusty service pin changed. Device access was not updated.")
  if (service.personManagement !== 1 || service.scopeManagement !== 1) throw new Error("Update Rusty before enabling device access")
  await ensureRustyPersonPolicy(service, profile, true, { allowLegacyMigration: true, ensureCurrent: guardOwner })
  await guardOwner()
  await resolveRustyManagementAuthority({ origin, servicePublicKey: config.servicePublicKey,
    resourceKind: "scope", resourceId: config.scopeId }, profile, "scope.policy", true, { ensureCurrent: guardOwner })
  await guardOwner()
}
