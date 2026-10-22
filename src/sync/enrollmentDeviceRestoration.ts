import type { LocalProfile } from "../domain/identity"
import { RustyManagementRepository } from "./rustyManagementRepository"
import { getPrivateReplicaConfigurations } from "./privateReplicaRepository"
import { readRustyManagementStatus, updateRustyManagementPolicy } from "./rustyManagementClient"
import { readLocal, updateLocal } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { myDeviceRemovalsKey, type MyDeviceRemoval } from "./myDeviceRemovalState"
import { identityDevicePreferencesChanged } from "./identityDevicePreferenceEvents"
import { assertReplicaCredentialsUnfrozen } from "./replicaCredentialFreeze"

/** Enrollment approval restores only this device's access to selected local replicas. */
export async function restoreEnrolledRustyAccess(profile: LocalProfile, deviceId: string,
  workspaceIds: string[], ensureCurrent: () => void): Promise<void> {
  const owner = profile.identity.personId
  const savedJobs = await readLocal(myDeviceRemovalsKey(owner))
  const jobs = savedJobs ? JSON.parse(savedJobs) as MyDeviceRemoval[] : []
  const reviewedOrigins = new Set(jobs.filter(job => job.deviceId === deviceId).flatMap(job => Object.keys(job.origins ?? {})))
  const configs = (await getPrivateReplicaConfigurations(profile.identity.personId))
    .filter(value => value.purpose === "identity" || workspaceIds.includes(value.workspaceId))
  const scopes = new Set(configs.map(value => `${value.origin}|${value.scopeId}`))
  const origins = new Set(configs.map(value => value.origin))
  const records = (await new RustyManagementRepository(profile.identity.personId).export())
    .filter(value => value.binding.resourceKind === "person" ? origins.has(value.binding.origin)
      : value.binding.resourceKind === "scope" && scopes.has(`${value.binding.origin}|${value.binding.resourceId}`))
    .sort((a, b) => Number(b.binding.resourceKind === "person") - Number(a.binding.resourceKind === "person"))
  for (const record of records) {
    if (record.capability.payload.revokedDeviceIds.includes(deviceId)) reviewedOrigins.add(record.binding.origin)
  }
  for (const { binding } of records.filter(record => reviewedOrigins.has(record.binding.origin))) {
    ensureCurrent()
    await assertReplicaCredentialsUnfrozen(profile.identity.personId, binding)
    const status = await readRustyManagementStatus(binding, profile, { ensureCurrent })
    ensureCurrent()
    const current = status.capability?.payload
    if (!current?.revokedDeviceIds.includes(deviceId)) continue
    await updateRustyManagementPolicy(binding, profile, { operations: current.operations,
      revokedDeviceIds: current.revokedDeviceIds.filter(id => id !== deviceId), restoredDeviceIds: [deviceId] }, { ensureCurrent })
    ensureCurrent()
  }
  // Retained signed evidence stays in authority stores; a new removal needs a new reviewed job.
  await withLocalStateWriteLock(`my-device-removal:${owner}`, async () => {
    ensureCurrent()
    await updateLocal(myDeviceRemovalsKey(owner), raw => {
      ensureCurrent()
      const jobs = raw ? JSON.parse(raw) as MyDeviceRemoval[] : []
      return JSON.stringify(jobs.filter(job => job.deviceId !== deviceId))
    })
  })
  identityDevicePreferencesChanged(owner)
}
