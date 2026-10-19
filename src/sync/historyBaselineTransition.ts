import { BrowserMeshStore, MemoryMeshStore } from "@meta-uber/mesh-browser-store"
import { canonicalizeJson, sha256Base64Url } from "@meta-uber/mesh-identity"
import type { LocalProfile } from "../domain/identity"
import type { useTincanban } from "../state"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { CaptureCheckpointPort } from "./historyBaselineCapture"
import type { BlindReplicaConfig } from "./blindReplication"
import { parseReplicaWriterWorkers, type ReplicaWriterWorker } from "./replicaWriterWorkersState"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"

const STORE = "records"
const DATABASE = "tincanban-history-baseline-transitions-v1"
const memory = new MemoryMeshStore()
const encoder = new TextEncoder()

type PreparedWorker = { route: ReplicaWriterWorker; sourceHeads: string[] }
type Transition = {
  kind: "workspace-history-baseline-transition"
  version: 1
  workspaceId: string
  transitionId: string
  configBinding: string
  previousBaselineId: string | null
  routes: ReplicaWriterWorker[]
  prepared: PreparedWorker[]
  baselineId: string | null
  activated: string[]
}

export type HistoryBaselineTransitionPorts = {
  assertSupported?: (origin: string) => Promise<void>
  readPublishedBaseline?: (config: BlindReplicaConfig) => Promise<{ baselineId: string } | undefined>
  prepare?: (route: ReplicaWriterWorker, transitionId: string, profile: LocalProfile, config: BlindReplicaConfig,
    scopeAuthoritySnapshot: unknown, ensureCurrent: () => void | Promise<void>) => Promise<{ transitionId: string; state: "frozen"; sourceHeads: string[] }>
  drainOwner: (frozen: PreparedWorker[]) => Promise<void>
  captureTransitionId?: string
  checkpointBeforeActivation?: CaptureCheckpointPort
  checkpointPublishedBaseline?: (baselineId: string) => Promise<void>
  captureAndPublish?: (frozen: PreparedWorker[], previousBaselineId: string | null) => Promise<{ baselineId: string }>
  ensureNativeCurrent?: () => void
  activate?: (route: ReplicaWriterWorker, transitionId: string, baselineId: string, profile: LocalProfile,
    config: BlindReplicaConfig, ensureCurrent: () => void | Promise<void>) => Promise<string>
  ensureCurrent: () => void | Promise<void>
}

function database() {
  return typeof indexedDB === "undefined" ? memory : new BrowserMeshStore(DATABASE, [STORE])
}

function keyFor(workspaceId: string, transitionId: string): Promise<string> {
  return sha256Base64Url(encoder.encode(canonicalizeJson([workspaceId, transitionId])))
}

function routeKey(route: ReplicaWriterWorker): string {
  return canonicalizeJson([route.origin, route.workspaceId, route.definitionId, route.executorPersonId, route.integrationId])
}

function captureTransition(value: unknown, workspaceId: string, transitionId: string): Transition {
  const record = structuredClone(value)
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid history transition journal")
  const valueRecord = record as Record<string, unknown>
  assertTransitionHeader(valueRecord, workspaceId, transitionId)
  const routes = parseReplicaWriterWorkers(valueRecord.routes, workspaceId)
  if (routes.length > 64 || valueRecord.prepared.length > routes.length || valueRecord.activated.length > routes.length) {
    throw new Error("History transition exceeds its route bound")
  }
  const { allowed, prepared, preparedRoutes } = capturePreparedWorkers(valueRecord.prepared, workspaceId, routes)
  const activated = valueRecord.activated.map(value => {
    if (typeof value !== "string" || !allowed.has(value) || !preparedRoutes.has(value)) throw new Error("Invalid activated Worker history transition")
    return value
  })
  if (new Set(activated).size !== activated.length || valueRecord.baselineId !== null && prepared.length !== routes.length) {
    throw new Error("History transition activation is inconsistent")
  }
  return { kind: "workspace-history-baseline-transition", version: 1, workspaceId, transitionId,
    configBinding: valueRecord.configBinding, previousBaselineId: valueRecord.previousBaselineId as string | null,
    routes, prepared, baselineId: valueRecord.baselineId as string | null, activated }
}

function capturePreparedWorkers(rawPrepared: unknown[], workspaceId: string, routes: ReplicaWriterWorker[]) {
  const allowed = new Set(routes.map(routeKey))
  const prepared: PreparedWorker[] = []
  const preparedRoutes = new Set<string>()
  for (const raw of rawPrepared) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid prepared Worker history transition")
    const item = raw as Record<string, unknown>
    if (Object.keys(item).length !== 2 || !Object.hasOwn(item, "route") || !Object.hasOwn(item, "sourceHeads") ||
        !Array.isArray(item.sourceHeads) || item.sourceHeads.length > 256 ||
        item.sourceHeads.some(head => typeof head !== "string" || !/^[a-f0-9]{64}$/.test(head))) {
      throw new Error("Invalid prepared Worker history transition")
    }
    const sourceHeads = item.sourceHeads as unknown[]
    const route = parseReplicaWriterWorkers([item.route], workspaceId)[0]!
    const routeKeyValue = routeKey(route)
    if (!allowed.has(routeKeyValue) || preparedRoutes.has(routeKeyValue)) throw new Error("Prepared Worker is outside this history transition")
    preparedRoutes.add(routeKeyValue)
    prepared.push({ route, sourceHeads: [...sourceHeads] as string[] })
  }
  return { allowed, prepared, preparedRoutes }
}

function isBaselineId(value: unknown) { return value === null || typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) }

function assertTransitionHeader(valueRecord: Record<string, unknown>, workspaceId: string, transitionId: string): asserts valueRecord is Record<string, unknown> & { routes: unknown[]; prepared: unknown[]; activated: unknown[]; configBinding: string } {
  const expectedKeys = ["kind", "version", "workspaceId", "transitionId", "configBinding", "previousBaselineId", "routes", "prepared", "baselineId", "activated"]
  if (Object.keys(valueRecord).length !== expectedKeys.length || expectedKeys.some(key => !Object.hasOwn(valueRecord, key)) ||
      valueRecord.kind !== "workspace-history-baseline-transition" || valueRecord.version !== 1 ||
      valueRecord.workspaceId !== workspaceId || valueRecord.transitionId !== transitionId ||
      typeof valueRecord.configBinding !== "string" || !valueRecord.configBinding ||
      !isBaselineId(valueRecord.previousBaselineId) ||
      !isBaselineId(valueRecord.baselineId) ||
      !Array.isArray(valueRecord.routes) || !Array.isArray(valueRecord.prepared) || !Array.isArray(valueRecord.activated)) {
    throw new Error("Invalid history transition journal")
  }
}

async function saveTransition(previous: string | undefined, next: Transition, key: string, guard: () => void | Promise<void>) {
  const raw = canonicalizeJson(next)
  await guard()
  const persistence = database()
  const condition = [{ store: STORE, key, expected: previous }]
  const write = [{ type: "put" as const, store: STORE, key, value: raw }]
  if (await persistence.compareAndSwap(condition, write, guard)) return raw
  const winner = await persistence.get<string>(STORE, key)
  await guard()
  if (winner === raw) return raw
  throw new Error("History transition changed during durable commit")
}

async function defaultAssertSupported(origin: string) {
  const { assertAutomationHistoryBaselineSupported } = await import("../app/automationInstanceClient")
  await assertAutomationHistoryBaselineSupported(origin)
}

async function defaultPrepare(route: ReplicaWriterWorker, id: string, signer: LocalProfile,
    currentConfig: BlindReplicaConfig, authority: unknown, guard: () => void | Promise<void>) {
  const { prepareAutomationHistoryBaseline } = await import("../app/automationInstanceClient")
  const result = await prepareAutomationHistoryBaseline(signer, { ...route, storage: {
    origin: currentConfig.origin, scopeId: currentConfig.scopeId, keyEpoch: currentConfig.keyEpoch,
    servicePublicKey: currentConfig.servicePublicKey,
  }, transitionId: id, scopeAuthoritySnapshot: authority }, { ensureCurrent: guard })
  const frozen = result.identity.description.historyTransition
  if (!frozen) throw new Error("Worker did not return its signed history freeze")
  return frozen
}

async function defaultActivate(route: ReplicaWriterWorker, id: string, baselineId: string,
    signer: LocalProfile, currentConfig: BlindReplicaConfig, guard: () => void | Promise<void>) {
  const { activateAutomationHistoryBaseline } = await import("../app/automationInstanceClient")
  const result = await activateAutomationHistoryBaseline(signer, { ...route, storage: {
    origin: currentConfig.origin, scopeId: currentConfig.scopeId, keyEpoch: currentConfig.keyEpoch,
    servicePublicKey: currentConfig.servicePublicKey,
  }, transitionId: id, baselineId }, { ensureCurrent: guard })
  return result.identity.description.historyBaselineId ?? ""
}

type HistoryTransitionInput = {
  profile: LocalProfile
  config: BlindReplicaConfig
  routes: ReplicaWriterWorker[]
  transitionId: string
  previousBaselineId?: string | null
  scopeAuthoritySnapshot: unknown
  ports: HistoryBaselineTransitionPorts
}

/** Resume the same durable freeze/capture/activation transition after lost replies or reload. */
export async function runWorkspaceHistoryBaselineTransition(input: HistoryTransitionInput) {
  const state = await loadHistoryTransition(input)
  const frozen = await prepareHistoryWorkers(state)
  await publishHistoryTransition(state, frozen)
  await state.ports.checkpointPublishedBaseline?.(state.transition.baselineId!)
  await state.ports.ensureCurrent()
  await activateHistoryWorkers(state)
  await state.ports.ensureCurrent()
  return { transitionId: state.transitionId, baselineId: state.transition.baselineId!, workers: frozen.length }
}

function assertOwnerTransition(input: HistoryTransitionInput, transitionId: string, routes: ReplicaWriterWorker[],
  previousBaselineId: string | null, scopeAuthoritySnapshot: unknown) {
  if (!/^[0-9a-f-]{36}$/.test(transitionId) || routes.length > 64 ||
      !(previousBaselineId === null || /^[A-Za-z0-9_-]{43}$/.test(previousBaselineId)) ||
      !scopeAuthoritySnapshot || typeof input.ports?.ensureCurrent !== "function") {
    throw new Error("Invalid owner history-baseline transition")
  }
}

async function loadHistoryTransition(input: HistoryTransitionInput) {
  const profile = structuredClone(input.profile)
  const config = structuredClone(input.config)
  const routes = parseReplicaWriterWorkers(structuredClone(input.routes), config.workspaceId)
  const scopeAuthoritySnapshot = structuredClone(input.scopeAuthoritySnapshot)
  const transitionId = input.transitionId
  const previousBaselineId = input.previousBaselineId ?? null
  assertOwnerTransition(input, transitionId, routes, previousBaselineId, scopeAuthoritySnapshot)
  const ports = { ...input.ports }
  const assertSupported = ports.assertSupported ?? defaultAssertSupported
  const prepare = ports.prepare ?? defaultPrepare
  const activate = ports.activate ?? defaultActivate
  const configBinding = canonicalizeJson({ workspaceId: config.workspaceId, origin: config.origin, scopeId: config.scopeId,
    servicePublicKey: config.servicePublicKey, keyEpoch: config.keyEpoch, policyRevision: config.policyRevision,
    keyDigest: await sha256Base64Url(decodeBlindBytes(config.contentKey)) })
  await ports.ensureCurrent()
  for (const origin of [...new Set(routes.map(route => route.origin))].sort()) {
    await assertSupported(origin)
    await ports.ensureCurrent()
  }
  const key = await keyFor(config.workspaceId, transitionId)
  const store = database()
  let raw = await store.get<string>(STORE, key)
  await ports.ensureCurrent()
  let transition: Transition
  if (raw === undefined) {
    transition = { kind: "workspace-history-baseline-transition", version: 1, workspaceId: config.workspaceId,
      transitionId, configBinding, previousBaselineId, routes, prepared: [], baselineId: null, activated: [] }
    raw = await saveTransition(undefined, transition, key, ports.ensureCurrent)
  } else {
    transition = captureTransition(JSON.parse(raw), config.workspaceId, transitionId)
    if (transition.configBinding !== configBinding || transition.previousBaselineId !== previousBaselineId ||
        canonicalizeJson(transition.routes) !== canonicalizeJson(routes)) {
      throw new Error("History transition does not match the current routes or Rusty scope")
    }
  }

  return { profile, config, routes, scopeAuthoritySnapshot, transitionId, previousBaselineId, ports, prepare, activate,
    key, raw, transition }
}
type HistoryTransitionState = Awaited<ReturnType<typeof loadHistoryTransition>>

async function prepareHistoryWorkers(state: HistoryTransitionState) {
  const { profile, config, routes, scopeAuthoritySnapshot, transitionId, ports, prepare, key } = state
  const preparedByRoute = new Map(state.transition.prepared.map(item => [routeKey(item.route), item]))
  for (const route of routes) {
    const routeId = routeKey(route)
    if (preparedByRoute.has(routeId)) continue
    await ports.ensureCurrent()
    const response = await prepare(route, transitionId, profile, config, scopeAuthoritySnapshot, ports.ensureCurrent)
    await ports.ensureCurrent()
    if (response.transitionId !== transitionId || response.state !== "frozen" || response.sourceHeads.length > 256 ||
        response.sourceHeads.some(head => !/^[a-f0-9]{64}$/.test(head)) || new Set(response.sourceHeads).size !== response.sourceHeads.length) {
      throw new Error("Worker did not confirm the exact durable history freeze")
    }
    const prepared = { route, sourceHeads: [...response.sourceHeads].sort() }
    state.transition = { ...state.transition, prepared: [...state.transition.prepared, prepared] }
    state.raw = await saveTransition(state.raw, state.transition, key, ports.ensureCurrent)
    preparedByRoute.set(routeId, prepared)
  }

  return routes.map(route => preparedByRoute.get(routeKey(route))!)
}

async function publishHistoryTransition(state: HistoryTransitionState, frozen: PreparedWorker[]) {
  const { ports, previousBaselineId, key } = state
  await ports.ensureCurrent()
  if (!state.transition.baselineId || !ports.checkpointPublishedBaseline) await ports.drainOwner(frozen)
  await ports.ensureCurrent()
  if (!state.transition.baselineId) {
    if (typeof ports.captureAndPublish !== "function") throw new Error("History baseline capture is unavailable")
    const published = await ports.captureAndPublish(frozen, previousBaselineId)
    await ports.ensureCurrent()
    if (!/^[A-Za-z0-9_-]{43}$/.test(published.baselineId)) throw new Error("Published history baseline identifier is invalid")
    state.transition = { ...state.transition, baselineId: published.baselineId }
    state.raw = await saveTransition(state.raw, state.transition, key, ports.ensureCurrent)
  }
}

async function activateHistoryWorkers(state: HistoryTransitionState) {
  const { config, ports, routes, transitionId, profile, activate, key } = state
  const readPublishedBaseline = ports.readPublishedBaseline ?? (async (currentConfig: BlindReplicaConfig) => {
    const publicationStore = await import("./historyBaselinePublicationRepository")
    const publication = await publicationStore.readPublishedHistoryBaseline(currentConfig.workspaceId, currentConfig, () => {})
    return publication ? { baselineId: publication.baselineId } : undefined
  })
  await ports.ensureCurrent()
  const published = await readPublishedBaseline(config)
  await ports.ensureCurrent()
  if (!published || published.baselineId !== state.transition.baselineId) {
    throw new Error("Worker activation requires the exact locally published history baseline")
  }

  const activated = new Set(state.transition.activated)
  for (const route of routes) {
    const routeId = routeKey(route)
    if (activated.has(routeId)) continue
    await ports.ensureCurrent()
    const acknowledged = await activate(route, transitionId, state.transition.baselineId!, profile, config, ports.ensureCurrent)
    await ports.ensureCurrent()
    if (acknowledged !== state.transition.baselineId) throw new Error("Worker activated a different history baseline")
    activated.add(routeId)
    state.transition = { ...state.transition, activated: [...activated].sort() }
    state.raw = await saveTransition(state.raw, state.transition, key, ports.ensureCurrent)
  }
}

/** Discover the signed Worker cohort and admitted scope anchor before starting a maintenance transition. */
export async function coordinateWorkspaceHistoryBaseline(input: {
  app: {
    readWorkspaceDoc: (workspaceId: string) => WorkspaceDocumentV2 | undefined | Promise<WorkspaceDocumentV2 | undefined>
    readWorkspaceBytes: (workspaceId: string) => Promise<Uint8Array>
    getCurrentProfile: () => LocalProfile | null | undefined
  }
  config: BlindReplicaConfig
  transitionId: string
  previousBaselineId?: string | null
  ports: HistoryBaselineTransitionPorts
}) {
  const config = structuredClone(input.config)
  const transitionId = input.transitionId
  const previousBaselineId = input.previousBaselineId ?? null
  const profileValue = input.app.getCurrentProfile()
  const profile = profileValue ? structuredClone(profileValue) : undefined
  if (!profile) throw new Error("Current identity is unavailable for history maintenance")
  await input.ports.ensureCurrent()
  const { discoverWorkspaceReplicaWorkers } = await import("./workspaceReplicaWorkers")
  const routes = await discoverWorkspaceReplicaWorkers(input.app, config, input.ports.ensureCurrent)
  const { peerStore } = await import("./peerStore")
  const authority = await peerStore.getWorkspaceAuthority(config.workspaceId) ??
    await peerStore.getWorkspaceCredential(config.workspaceId)
  await input.ports.ensureCurrent()
  const scopeAuthoritySnapshot = authority?.scopeAuthoritySnapshot
  if (!scopeAuthoritySnapshot) throw new Error("History maintenance requires an admitted signed scope authority")
  const ports: HistoryBaselineTransitionPorts = { ...input.ports }
  if (!ports.captureAndPublish) {
    if (typeof ports.ensureNativeCurrent !== "function") throw new Error("History capture requires a synchronous current-identity guard")
    ports.captureAndPublish = async (_frozen, previous) => {
      const { captureWorkspaceHistoryBaselineFromApp } = await import("./historyBaselineCapture")
      return captureWorkspaceHistoryBaselineFromApp({ tincanban: input.app as ReturnType<typeof useTincanban>,
        config, transitionId: ports.captureTransitionId ?? transitionId, previousBaselineId: previous, scopeAuthority: scopeAuthoritySnapshot,
        ensureCurrent: ports.ensureCurrent, ensureNativeCurrent: ports.ensureNativeCurrent!, checkpointBeforeActivation: ports.checkpointBeforeActivation })
    }
  }
  return runWorkspaceHistoryBaselineTransition({ profile, config, routes, transitionId,
    previousBaselineId, scopeAuthoritySnapshot, ports })
}
