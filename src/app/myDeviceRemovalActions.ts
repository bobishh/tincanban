import type { Ref } from "vue"
import type { useAppCore } from "./useAppCore"
import type { PreparedDeviceRemoval } from "./useMyDeviceRemoval"
import { compareAndSwapLocal, readLocal, updateLocal } from "../localDb"
import { withLocalStateWriteLock } from "../localStateLock"
import { continueMyDeviceRemoval, myDeviceRemovalComplete, myDeviceRemovalsKey, type MyDeviceRemoval } from "../sync/myDeviceRemoval"
import { identityDevicePreferencesChanged } from "../sync/identityDevicePreferenceEvents"

function captureReviewedOrigins(job: MyDeviceRemoval, previous: MyDeviceRemoval | undefined, includeNewOrigins: boolean, origins: string[]) {
  if (previous && !includeNewOrigins) return
  if (previous && !myDeviceRemovalComplete(previous)) throw new Error("Finish the recorded device removal before confirming additional servers")
  for (const origin of origins) {
    job.origins[origin] ??= { status: "pending" }
  }
}

/** Explicit reviewed actions; startup restoration stays in the lightweight owner. */
export function createMyDeviceRemovalActions(core: ReturnType<typeof useAppCore>,
  { pending, origins, refresh }: { pending: Ref<string>; origins: Readonly<Ref<string[]>>; refresh: () => Promise<void> }) {
  const replication = core.blindReplication
  const key = myDeviceRemovalsKey
  const parse = (raw: string | null): MyDeviceRemoval[] => raw ? JSON.parse(raw) as MyDeviceRemoval[] : []
  function guard(prepared: PreparedDeviceRemoval) {
    const current = core.tincanban.getCurrentProfile(), job = prepared.job
    if (current?.identity.personId !== job.personId || current.device.deviceId !== job.signerDeviceId || current.certificate.signature !== prepared.certificateSignature)
      throw new Error("Identity changed during device removal")
  }
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
          if (previous.abandonedOrigins?.some(origin => Object.hasOwn(job.origins, origin) && !job.abandonedOrigins?.includes(origin)))
            throw new Error("Server removal was stopped after this review; review it again")
          for (const [id, state] of Object.entries(previous.workspaces)) job.workspaces[id] = state
          for (const [origin, state] of Object.entries(previous.origins)) job.origins[origin] = state
          job.workspaceErrors = previous.workspaceErrors
          job.abandonedOrigins = previous.abandonedOrigins
        }
        if (job.abandonedOrigins) job.abandonedOrigins = job.abandonedOrigins.filter(origin => !Object.hasOwn(job.origins, origin))
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
  async function abandonOrigin(input: PreparedDeviceRemoval, origin: string) {
    if (pending.value) throw new Error("Another device removal action is pending")
    const prepared = structuredClone(input), job = prepared.job
    guard(prepared)
    if (job.origins[origin]?.status !== "pending") throw new Error("Choose a pending server removal")
    pending.value = job.deviceId
    try {
      await withLocalStateWriteLock(`my-device-removal:${job.personId}`, async () => {
        guard(prepared)
        const recordKey = key(job.personId), raw = await readLocal(recordKey)
        const saved = parse(raw), current = saved.find(value => value.deviceId === job.deviceId)
        if (JSON.stringify(current) !== JSON.stringify(job)) throw new Error("Recorded removal changed; review it again")
        const next = structuredClone(job)
        delete next.origins[origin]
        next.abandonedOrigins = [...new Set([...(next.abandonedOrigins ?? []), origin])]
        const archiveKey = `tincanban.device-removal-abandonment.v1.${crypto.randomUUID()}`
        const audit = JSON.stringify({ personId: job.personId, signerDeviceId: job.signerDeviceId,
          deviceId: job.deviceId, origin, previous: raw })
        if (!await compareAndSwapLocal({ conditions: [{ key: recordKey, value: raw }, { key: archiveKey, value: null }],
          writes: [{ key: recordKey, value: JSON.stringify(saved.map(value => value.deviceId === job.deviceId ? next : value)) },
            { key: archiveKey, value: audit }] }, () => guard(prepared))) throw new Error("Recorded removal changed; review it again")
      })
      guard(prepared)
      identityDevicePreferencesChanged(job.personId)
      await refresh()
    } finally { pending.value = "" }
  }
  return { prepare, remove, abandonOrigin }
}
