import { onBeforeUnmount, ref, watch, type Ref } from "vue"
import type { useTincanban } from "../state"
import type { LocalProfile } from "../domain/identity"
import { canonicalizeJson } from "../domain/identity"
import { subscribeIdentityDevicePreferences } from "./identityDevicePreferenceEvents"
import { subscribeChat } from "../chat/service"
import { encodeBlindBytes } from "./blindEnvelope"
import { loadReplicaConfigs } from "./blindReplicaSettings"
import type { BlindReplica, BlindReplicaConfig } from "./blindReplication"
import { replicaKey, type ReplicaHealth } from "./replicationHealth"
import type { AutomationConfiguration } from "../app/automation"
import { exportApprovedAutomation } from "../app/automationActivation"

export type BlindReplicationController = ReturnType<typeof useBlindReplication>

function createReplicationState() {
  return {
    configs: ref<BlindReplicaConfig[]>([]), statuses: ref<Record<string, ReplicaHealth>>({}), now: ref(Date.now()),
    busy: ref(false), error: ref(""), notice: ref(""),
  }
}

/** Credentials remain in private local storage, never in the shared board. */
export function useBlindReplication(tincanban: ReturnType<typeof useTincanban>) {
  const { configs, statuses, now, busy, error, notice } = createReplicationState()
  let identity = ""
  let running: Promise<void> | undefined
  let disposed = false
  const replicas = new Map<string, BlindReplica>()
  const personId = () => tincanban.getCurrentProfile()?.identity.personId ?? ""
  async function persist(config: BlindReplicaConfig, owner: string) {
    const next = await persistReplicaCursor(owner, config, () => {
      if (disposed || identity !== owner || personId() !== owner) throw new Error("Identity changed during Rusty replication")
    })
    if (disposed || identity !== owner || personId() !== owner) throw new Error("Identity changed during Rusty replication")
    configs.value = next
  }
  async function replica(config: BlindReplicaConfig): Promise<BlindReplica> {
    const id = `${config.origin}/${config.scopeId}`
    let result = replicas.get(id)
    if (!result) {
      const owner = identity
      const ensureIdentity = () => { if (disposed || owner !== personId()) throw new Error("Identity changed during Rusty replication") }
      result = await createReplica(config, tincanban, ensureIdentity, value => persist(value, owner))
      replicas.set(id, result)
    }
    return result
  }
  function syncNow(): Promise<void> {
    if (running) return running
    if (busy.value || !identity || disposed || configs.value.length === 0) return Promise.resolve()
    busy.value = true
    error.value = ""
    notice.value = ""
    const owner = identity
    const run = async () => {
      const failures: string[] = []
      for (const config of [...configs.value]) {
        if (disposed || identity !== owner) return
        const message = await recordReplicaHealth(config, statuses,
          async () => config.removalPending ? revoke(config) : (await replica(config)).sync(),
          () => !disposed && identity === owner)
        if (message) failures.push(message)
      }
      if (failures.length) error.value = failures.join("; ")
      else notice.value = "Encrypted board history and chat replicated."
    }
    running = run().finally(() => { running = undefined; busy.value = false })
    return running
  }
  async function attach(originInput: string, workspaceId: string) {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    busy.value = true
    try { await connectScope(originInput, workspaceId) } finally { busy.value = false }
    await syncNow()
  }
  async function connectScope(originInput: string, workspaceId: string) {
    const owner = personId()
    const doc = await tincanban.readWorkspaceDoc(workspaceId)
    if (!owner || doc.ownerPersonId !== owner) throw new Error("Only the workspace owner can configure Rusty")
    const { discoverBlindKeeper } = await import("./blindClient")
    const service = await discoverBlindKeeper(originInput)
    if (configs.value.some(config => config.origin === service.origin && config.workspaceId === workspaceId)) throw new Error("Rusty already connected to this board")
    const config: BlindReplicaConfig = { ...service, workspaceId, scopeId: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))),
      readToken: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), writeToken: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))),
      contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), keyEpoch: 1, policyRevision: 1, cursor: 0, lastUploaded: "" }
    const profile = tincanban.getCurrentProfile()
    if (!profile || profile.identity.personId !== owner) throw new Error("Identity unavailable")
    config.policyRevision = await approveScope(config, profile)
    if (owner !== identity || owner !== personId()) throw new Error("Identity changed during Rusty setup")
    await recordReplicaPreference(owner, config)
    configs.value = await loadReplicaConfigs(owner)
  }
  async function revoke(config: BlindReplicaConfig) {
    const profile = tincanban.getCurrentProfile()
    if (!profile || profile.identity.personId !== identity) throw new Error("Identity unavailable")
    await approveScope(config, profile, true)
    if (personId() !== profile.identity.personId) throw new Error("Identity changed during Rusty removal")
    await recordReplicaPreference(identity, config, true)
    const next = await loadReplicaConfigs(identity)
    replicas.delete(`${config.origin}/${config.scopeId}`)
    configs.value = next
    const nextStatuses = { ...statuses.value }
    delete nextStatuses[replicaKey(config)]
    statuses.value = nextStatuses
  }
  async function remove(config: BlindReplicaConfig) {
    if (busy.value) throw new Error("Wait for current Rusty sync to finish")
    notice.value = ""
    error.value = ""
    busy.value = true
    try { await recordReplicaPreference(identity, { ...config, removalPending: true }); await revoke(config); notice.value = "Rusty removed. Your board stays on this device." }
    catch (cause) { error.value = "Removal pending. Rusty must confirm that access was revoked."; throw cause }
    finally { busy.value = false }
  }
  async function exportAutomationAccess(config: BlindReplicaConfig, workerIdentity: string, configuration?: AutomationConfiguration): Promise<string> {
    if (personId() !== identity) throw new Error("Identity unavailable")
    return exportApprovedAutomation(tincanban, config, workerIdentity, configuration)
  }
  const stop = watch(() => { void tincanban.docVersion.value; return tincanban.ready.value ? personId() : "" }, async owner => {
    if (owner === identity) return
    identity = owner
    configs.value = []
    statuses.value = {}
    error.value = ""
    notice.value = ""
    replicas.clear()
    if (!owner) return
    try {
      const saved = await loadReplicaConfigs(owner)
      if (identity !== owner || disposed) return
      configs.value = saved
      await syncNow()
    } catch (cause) { error.value = cause instanceof Error ? cause.message : "Rusty settings unavailable" }
  }, { immediate: true })
  const healthClock = setInterval(() => { now.value = Date.now() }, 1000)
  const timer = setInterval(() => { void syncNow() }, 15000)
  const stopWorkspace = tincanban.subscribeLocalChanges(() => { void syncNow() })
  const stopChat = subscribeChat(() => { void syncNow() })
  const stopPreferences = watchReplicaSettings(() => identity, () => disposed, () => running, configs, error, replicas, syncNow)
  onBeforeUnmount(() => { disposed = true; stop(); clearInterval(timer); clearInterval(healthClock); stopWorkspace(); stopChat(); stopPreferences() })
  return { configs, statuses, now, busy, error, notice, attach, exportAutomationAccess, remove, syncNow }
}

async function approveScope(config: BlindReplicaConfig, profile: LocalProfile, revoked = false) {
  const { approveRustyScope } = await import("./rustyEnrollment")
  return approveRustyScope(config, profile, revoked)
}

async function recordReplicaPreference(owner: string, config: BlindReplicaConfig, removed = false) {
  return (await import("./identityDevicePreferences")).recordReplicaPreference(owner, config, removed)
}
async function persistReplicaCursor(owner: string, config: BlindReplicaConfig, ensureIdentity: () => void) {
  return (await import("./identityDevicePreferences")).persistReplicaCursor(owner, config, ensureIdentity)
}

async function createReplica(config: BlindReplicaConfig, tincanban: ReturnType<typeof useTincanban>, ensureIdentity: () => void,
  persist: (config: BlindReplicaConfig) => Promise<void>) {
  const { createBlindReplica } = await import("./blindReplicaStore")
  return createBlindReplica(config, tincanban, ensureIdentity, persist)
}


async function recordReplicaHealth(config: BlindReplicaConfig, statuses: Ref<Record<string, ReplicaHealth>>,
  operation: () => Promise<boolean | void>, isCurrent: () => boolean): Promise<string | undefined> {
  const key = replicaKey(config)
  const previous = statuses.value[key]
  statuses.value = { ...statuses.value, [key]: { phase: "syncing", lastSyncedAt: previous?.lastSyncedAt } }
  try {
    const caughtUp = await operation()
    if (!isCurrent() || config.removalPending) return
    statuses.value = { ...statuses.value, [key]: caughtUp === false
      ? { phase: "catching-up", lastSyncedAt: previous?.lastSyncedAt }
      : { phase: "synced", lastSyncedAt: Date.now() } }
  } catch (cause) {
    if (!isCurrent()) return
    const message = cause instanceof Error ? cause.message : "Rusty unavailable"
    statuses.value = { ...statuses.value, [key]: { phase: "error", lastSyncedAt: previous?.lastSyncedAt, error: message } }
    return message
  }
}



function watchReplicaSettings(identity: () => string, disposed: () => boolean, running: () => Promise<void> | undefined,
  configs: Ref<BlindReplicaConfig[]>, error: Ref<string>, replicas: Map<string, BlindReplica>, syncNow: () => Promise<void>) {
  return subscribeIdentityDevicePreferences(owner => {
    if (owner !== identity() || disposed()) return
    void (async () => {
      await running()?.catch(() => {})
      const saved = await loadReplicaConfigs(owner)
      if (disposed() || owner !== identity()) return
      if (canonicalizeJson(saved) === canonicalizeJson(configs.value)) return
      configs.value = saved; replicas.clear()
      await syncNow()
    })().catch(cause => { if (!disposed() && owner === identity()) error.value = cause instanceof Error ? cause.message : "Rusty settings unavailable" })
  })
}
