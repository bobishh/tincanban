import type { useTincanban } from "../state"
import type { PrivateReplicationState } from "./privateReplicationState"
import type { createPrivateReplicaRuntime } from "./privateReplicaLoop"
import { defaultStorage } from "../storage"

export function createDeviceAccessRefresh(tincanban: ReturnType<typeof useTincanban>, state: PrivateReplicationState,
  runtime: ReturnType<typeof createPrivateReplicaRuntime>, isCurrent: (owner: string, epoch: number) => boolean) {
  const { configs, identityConfigs, currentDeviceId, registeredDevices, pendingDeviceRevocations, revokedDeviceAccess } = state
  let loadedDeviceAccessOrigins = new Set<string>()
  async function refreshRevocations(profile: NonNullable<ReturnType<typeof tincanban.getCurrentProfile>>, owner: string, epoch: number) {
    const pinsByOrigin = new Map<string, Set<string>>()
    for (const config of [...configs.value, ...identityConfigs.value]) {
      if (!pinsByOrigin.has(config.origin)) pinsByOrigin.set(config.origin, new Set())
      pinsByOrigin.get(config.origin)!.add(config.servicePublicKey)
    }
    for (const [origin, pins] of pinsByOrigin) {
      if (loadedDeviceAccessOrigins.has(origin) || pins.size !== 1) continue
      loadedDeviceAccessOrigins.add(origin)
      try {
        const guard = runtime.captureSession(undefined, owner, epoch)
        guard()
        const { readRustyManagementStatus } = await import("./rustyManagementClient")
        guard()
        const status = await readRustyManagementStatus({ origin, servicePublicKey: [...pins][0]!, resourceKind: "person", resourceId: owner }, profile,
          { ensureCurrent: guard })
        if (!isCurrent(owner, epoch)) return
        for (const deviceId of status.capability?.payload.revokedDeviceIds ?? []) {
          const item = `${origin}|${deviceId}`
          if (!revokedDeviceAccess.value.includes(item)) revokedDeviceAccess.value = [...revokedDeviceAccess.value, item]
        }
      } catch { /* A status read cannot authorize or mutate access; leave removal available for an explicit retry. */ }
    }
  }
  async function refreshDeviceAccess(owner: string, epoch: number) {
    const profile = tincanban.getCurrentProfile()
    if (!profile || profile.identity.personId !== owner) return
    currentDeviceId.value = profile.device.deviceId
    const root = await defaultStorage.loadPersonalRoot()
    if (!isCurrent(owner, epoch)) return
    registeredDevices.value = root?.identity.personId === owner ? Object.values(root.devices).map(value => structuredClone(value)) : []
    const origins = [...new Set([...configs.value, ...identityConfigs.value].map(config => config.origin))]
    const pending = await Promise.all(origins.map(async origin => {
      const { readCredentialTransitionJournal } = await import("./replicaCredentialTransitionJournal")
      if (!isCurrent(owner, epoch)) return undefined
      const journal = await readCredentialTransitionJournal(profile, origin)
      return journal?.freeze.revokedDeviceId ? `${origin}|${journal.freeze.revokedDeviceId}` : undefined
    }))
    if (!isCurrent(owner, epoch)) return
    pendingDeviceRevocations.value = pending.filter((value): value is string => !!value)
    await refreshRevocations(profile, owner, epoch)
  }
  return { refresh: refreshDeviceAccess, reset: () => { loadedDeviceAccessOrigins = new Set() } }
}
