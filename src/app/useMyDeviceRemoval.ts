import { computed, onScopeDispose, ref, watch } from "vue"
import type { useAppCore } from "./useAppCore"
import type * as DeviceRemovalActions from "./myDeviceRemovalActions"
import { readLocal } from "../localDb"
import { myDeviceRemovalsKey, type MyDeviceRemoval } from "../sync/myDeviceRemovalState"
import { subscribeIdentityDevicePreferences } from "../sync/identityDevicePreferenceEvents"
export { myDeviceRemovalComplete } from "../sync/myDeviceRemovalState"


export type PreparedDeviceRemoval = { job: MyDeviceRemoval; certificateSignature: string }
/** Local intent survives offline servers; signed evidence remains in the existing authority stores. */
export function useMyDeviceRemoval(core: ReturnType<typeof useAppCore>,
  loadActions: () => Promise<typeof DeviceRemovalActions> = () => import("./myDeviceRemovalActions")) {
  const jobs = ref<MyDeviceRemoval[]>([]), pending = ref("")
  const replication = core.blindReplication
  const key = myDeviceRemovalsKey
  let refreshVersion = 0, disposed = false
  const parse = (raw: string | null): MyDeviceRemoval[] => raw ? JSON.parse(raw) as MyDeviceRemoval[] : []
  async function refresh() {
    const version = ++refreshVersion
    if (typeof core.tincanban.getCurrentProfile !== "function") return
    const profile = core.tincanban.getCurrentProfile()
    if (!profile) { jobs.value = []; return }
    const value = parse(await readLocal(key(profile.identity.personId)))
    if (version === refreshVersion && core.tincanban.getCurrentProfile()?.identity.personId === profile.identity.personId) jobs.value = value
  }
  watch(() => [core.tincanban.ready?.value, replication?.currentDeviceId?.value], () => { void refresh() }, { immediate: true })
  const stopPreferences = subscribeIdentityDevicePreferences(owner => {
    if (owner === core.tincanban.getCurrentProfile()?.identity.personId) void refresh()
  })
  onScopeDispose(() => { disposed = true; refreshVersion++; stopPreferences() })
  const origins = computed(() => [...new Set([...replication.configs.value.filter(config => !config.boardAccess),
    ...replication.identityConfigs.value].map(config => config.origin))])
  async function runAction<T>(run: (actions: ReturnType<typeof DeviceRemovalActions.createMyDeviceRemovalActions>) => Promise<T>) {
    const binding = () => {
      const profile = core.tincanban.getCurrentProfile()
      return JSON.stringify([profile?.identity.personId, profile?.device.deviceId, profile?.certificate.signature])
    }
    const captured = binding(), module = await loadActions()
    if (disposed || binding() !== captured) throw new Error("Identity changed during device removal")
    return run(module.createMyDeviceRemovalActions(core, { pending, origins, refresh }))
  }
  const prepare = (deviceId: string, includeNewOrigins = false) => runAction(actions => actions.prepare(deviceId, includeNewOrigins))
  const remove = async (input: PreparedDeviceRemoval) => {
    const captured = structuredClone(input)
    return runAction(actions => actions.remove(captured))
  }
  const abandonOrigin = async (input: PreparedDeviceRemoval, origin: string) => {
    const captured = structuredClone(input)
    return runAction(actions => actions.abandonOrigin(captured, origin))
  }
  return { jobs, pending, origins, prepare, remove, abandonOrigin, refresh }
}
