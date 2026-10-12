import { onBeforeUnmount, ref, watch, type Ref } from "vue"
import type { useTincanban } from "../state"
import type { LocalProfile } from "../domain/identity"
import { readLocal, writeLocal } from "../localDb"
import { subscribeChat } from "../chat/service"
import { blindOrigin } from "./blindOrigin"
import { decodeBlindBytes, encodeBlindBytes } from "./blindEnvelope"
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
  const storageKey = (personId: string) => `tincanban.blind-replicas.v1.${personId}`
  const personId = () => tincanban.getCurrentProfile()?.identity.personId ?? ""
  async function persist(config: BlindReplicaConfig, owner: string) {
    if (disposed || identity !== owner || personId() !== owner) throw new Error("Identity changed during Rusty replication")
    const next = configs.value.map(value => value.scopeId === config.scopeId && value.origin === config.origin ? { ...config } : value)
    await writeLocal(storageKey(owner), JSON.stringify(next))
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
    const next = [...configs.value, config]
    await writeLocal(storageKey(owner), JSON.stringify(next))
    configs.value = next
  }
  async function revoke(config: BlindReplicaConfig) {
    const profile = tincanban.getCurrentProfile()
    if (!profile || profile.identity.personId !== identity) throw new Error("Identity unavailable")
    await approveScope(config, profile, true)
    if (personId() !== profile.identity.personId) throw new Error("Identity changed during Rusty removal")
    const next = configs.value.filter(value => value.scopeId !== config.scopeId || value.origin !== config.origin)
    await writeLocal(storageKey(identity), JSON.stringify(next))
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
    try { await persist({ ...config, removalPending: true }, identity); await revoke(config); notice.value = "Rusty removed. Your board stays on this device." }
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
  onBeforeUnmount(() => { disposed = true; stop(); clearInterval(timer); clearInterval(healthClock); stopWorkspace(); stopChat() })
  return { configs, statuses, now, busy, error, notice, attach, exportAutomationAccess, remove, syncNow }
}

async function approveScope(config: BlindReplicaConfig, profile: LocalProfile, revoked = false) {
  const { approveRustyScope } = await import("./rustyEnrollment")
  return approveRustyScope(config, profile, revoked)
}

async function createReplica(config: BlindReplicaConfig, tincanban: ReturnType<typeof useTincanban>, ensureIdentity: () => void,
  persist: (config: BlindReplicaConfig) => Promise<void>) {
  const { createBlindReplica } = await import("./blindReplicaStore")
  return createBlindReplica(config, tincanban, ensureIdentity, persist)
}

async function loadReplicaConfigs(owner: string): Promise<BlindReplicaConfig[]> {
  const saved = await readLocal(`tincanban.blind-replicas.v1.${owner}`)
  const values: unknown = saved ? JSON.parse(saved) as unknown : []
  if (!Array.isArray(values) || values.length > 128) throw new Error("Invalid Rusty local settings")
  return values.map(value => parseConfig(JSON.stringify(value)))
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


function parseConfig(text: string): BlindReplicaConfig {
  const input = JSON.parse(text) as BlindReplicaConfig
  if (!input || typeof input !== "object") throw new Error("Invalid Rusty local settings")
  const validId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0
  const validToken = (value: string) => validId(value) && value.length >= 43
  const validWorkspace = typeof input.workspaceId === "string" && input.workspaceId.length > 0 && input.workspaceId.length <= 256
  const validEpoch = positive(input.keyEpoch) && positive(input.policyRevision)
  const validCursor = Number.isSafeInteger(input.cursor) && input.cursor >= 0
  const validHash = typeof input.lastUploaded === "string" && (input.lastUploaded === "" || /^[A-Za-z0-9_-]{43}$/.test(input.lastUploaded))
  if ([validId(input.scopeId), validWorkspace, validEpoch, validCursor, validHash, validToken(input.readToken), validToken(input.writeToken)].some(valid => !valid)) {
    throw new Error("Invalid Rusty local settings")
  }
  if (decodeBlindBytes(input.contentKey).length !== 32 || decodeBlindBytes(input.servicePublicKey).length !== 32) throw new Error("Invalid Rusty key")
  if (input.removalPending !== undefined && typeof input.removalPending !== "boolean") throw new Error("Invalid Rusty removal state")
  return { origin: blindOrigin(input.origin), scopeId: input.scopeId, workspaceId: input.workspaceId, servicePublicKey: input.servicePublicKey,
    readToken: input.readToken, writeToken: input.writeToken, contentKey: input.contentKey, keyEpoch: input.keyEpoch, policyRevision: input.policyRevision, cursor: input.cursor, lastUploaded: input.lastUploaded, ...(input.removalPending ? { removalPending: true } : {}) }
}
