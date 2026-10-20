import { computed, ref, watch } from "vue"
import type { useAppCore } from "./useAppCore"
import { readLocal, updateLocal } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { continueMyDeviceRemoval, myDeviceRemovalComplete, type MyDeviceRemoval } from "../sync/myDeviceRemoval"
export { myDeviceRemovalComplete } from "../sync/myDeviceRemoval"


function captureReviewedOrigins(job: MyDeviceRemoval, previous: MyDeviceRemoval | undefined, includeNewOrigins: boolean, origins: string[]) {
  if (previous && !includeNewOrigins) return
  if (previous && !myDeviceRemovalComplete(previous)) throw new Error("Finish the recorded device removal before confirming additional servers")
  for (const origin of origins) job.origins[origin] ??= { status: "pending" }
}

export type PreparedDeviceRemoval = { job: MyDeviceRemoval; certificateSignature: string }
/** Local intent survives offline servers; signed evidence remains in the existing authority stores. */
export function useMyDeviceRemoval(core: ReturnType<typeof useAppCore>) {
  const jobs = ref<MyDeviceRemoval[]>([]), pending = ref("")
  const replication = core.blindReplication
  const key = (personId: string) => `tincanban.my-device-removals.v1.${personId}`
  const parse = (raw: string | null): MyDeviceRemoval[] => raw ? JSON.parse(raw) as MyDeviceRemoval[] : []
  function guard(prepared: PreparedDeviceRemoval) {
    const current = core.tincanban.getCurrentProfile(), job = prepared.job
    if (current?.identity.personId !== job.personId || current.device.deviceId !== job.signerDeviceId || current.certificate.signature !== prepared.certificateSignature)
      throw new Error("Identity changed during device removal")
  }
  async function refresh() {
    const profile = core.tincanban.getCurrentProfile()
    if (!profile) { jobs.value = []; return }
    const value = parse(await readLocal(key(profile.identity.personId)))
    if (core.tincanban.getCurrentProfile()?.identity.personId === profile.identity.personId) jobs.value = value
  }
  watch(() => [core.tincanban.ready.value, replication.currentDeviceId.value], () => { void refresh() }, { immediate: true })
  const origins = computed(() => [...new Set([...replication.configs.value.filter(config => !config.boardAccess),
    ...replication.identityConfigs.value].map(config => config.origin))])
  async function prepare(deviceId: string, includeNewOrigins = false): Promise<PreparedDeviceRemoval> {
    const profile = core.tincanban.getCurrentProfile()
    if (!profile || deviceId === profile.device.deviceId) throw new Error("Remove this device from another device")
    const device = replication.registeredDevices.value.find(device => device.deviceId === deviceId)
    if (!device) throw new Error("Choose another registered device of your identity")
    const prepared: PreparedDeviceRemoval = { certificateSignature: profile.certificate.signature, job: {
      version: 1, personId: profile.identity.personId, signerDeviceId: profile.device.deviceId, deviceId,
      name: device.displayName, workspaces: {}, workspaceTitles: {}, origins: {} } }
    const previous = parse(await readLocal(key(profile.identity.personId))).find(job => job.deviceId === deviceId)
    guard(prepared)
    if (previous) {
      if (previous.signerDeviceId !== profile.device.deviceId) throw new Error("Resume removal on the device that started it")
      prepared.job = structuredClone(previous)
    } else {
      const eligible = await core.sync.removableDeviceWorkspaces(profile.identity.personId, deviceId)
      guard(prepared)
      for (const workspace of eligible) { prepared.job.workspaces[workspace.id] = "pending"; prepared.job.workspaceTitles![workspace.id] = workspace.title }
    }
    captureReviewedOrigins(prepared.job, previous, includeNewOrigins, origins.value)
    if (!Object.keys(prepared.job.workspaces).length && !Object.keys(prepared.job.origins).length)
      throw new Error("No authorized workspace or Rusty access available to revoke for this device")
    guard(prepared)
    return structuredClone(prepared)
  }
  async function remove(input: PreparedDeviceRemoval) {
    if (pending.value) return
    const prepared = structuredClone(input), job = prepared.job
    guard(prepared)
    if (job.deviceId === job.signerDeviceId || !replication.registeredDevices.value.some(device => device.deviceId === job.deviceId))
      throw new Error("Choose another registered device of your identity")
    pending.value = job.deviceId
    try {
      await withLocalStateWriteLock(`my-device-removal:${job.personId}`, async () => {
        guard(prepared)
        const previous = parse(await readLocal(key(job.personId))).find(value => value.deviceId === job.deviceId)
        guard(prepared)
        if (previous) {
          if (previous.signerDeviceId !== job.signerDeviceId || Object.keys(previous.workspaces).some(id => !Object.hasOwn(job.workspaces, id)) ||
              Object.keys(previous.origins).some(origin => !Object.hasOwn(job.origins, origin))) throw new Error("Recorded removal scope changed; review it again")
          for (const [id, state] of Object.entries(previous.workspaces)) job.workspaces[id] = state
          for (const [origin, state] of Object.entries(previous.origins)) job.origins[origin] = state
          job.workspaceErrors = previous.workspaceErrors
        }
        const save = async (changed: MyDeviceRemoval) => {
          guard(prepared)
          await updateLocal(key(job.personId), raw => { guard(prepared); return JSON.stringify([...parse(raw).filter(value => value.deviceId !== job.deviceId), changed]) })
          guard(prepared)
          await refresh()
          guard(prepared)
        }
        await save(job)
        await continueMyDeviceRemoval(job, { ensureCurrent: () => guard(prepared), save,
          removeWorkspaces: ids => core.sync.removeDevice(job.personId, job.deviceId, ids),
          revokeOrigin: origin => replication.revokeIdentityDevice(origin, job.deviceId) })
      })
    } finally { pending.value = "" }
  }
  return { jobs, pending, origins, prepare, remove, refresh }
}
