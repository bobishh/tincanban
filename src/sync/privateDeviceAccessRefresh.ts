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
    for (const config of [...configs.value.filter(config => !config.boardAccess), ...identityConfigs.value]) {
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
    const origins = [...new Set([...configs.value.filter(config => !config.boardAccess), ...identityConfigs.value,
      ...state.preferenceConflicts.value].map(config => config.origin))]
    const { readPendingRustyOperation } = await import("./pendingRustyOperation")
    const operations = await Promise.all(origins.map(origin => readPendingRustyOperation(profile, origin)))
    if (!isCurrent(owner, epoch)) return
    state.pendingRustyOperations.value = operations.filter(operation => operation !== undefined)
    pendingDeviceRevocations.value = operations.flatMap(operation => operation?.kind === "device-revocation"
      ? [`${operation.origin}|${operation.deviceId}`] : [])
    await refreshRevocations(profile, owner, epoch)
  }
  return { refresh: refreshDeviceAccess, reset: () => { loadedDeviceAccessOrigins = new Set() } }
}
