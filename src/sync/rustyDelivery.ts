import type { BlindReplicaConfig, IdentityReplicaConfig, PrivateReplicaConfig } from "./blindReplication"
import type { Ref } from "vue"
import { privateReplicaOperationKey } from "./privateReplicaBinding"
import type { createPrivateReplicaRuntime } from "./privateReplicaLoop"
import { reportDeviceSyncProblem, type PrivateReplicationState } from "./privateReplicationState"
import type { createBoardFreshness, recordReplicaHealth } from "./replicaHealthRun"
import { requiresRustyPermissionMigration } from "./rustyPermissionMigration"
import { createReplicationFollowUp } from "./privateReplicationTriggers"

/** Identity and session captured with a board intent. A later session cannot replay it. */
type DeliverySession = { readonly owner: string; readonly epoch: number }

type BindingCurrent = () => boolean
type ScopeDeliver = (workspaceId: string, changed: boolean) => Promise<void>

type RustyDeliveryHost = {
  capture(): DeliverySession
  matches(session: DeliverySession): boolean
  accessReserved(): boolean
  canStart(duringAction: boolean): boolean
  activeWorkspaceId(): string
  boards(): readonly BlindReplicaConfig[]
  profiles(): readonly IdentityReplicaConfig[]
  bindingKey(config: PrivateReplicaConfig, session: DeliverySession): string
  installed(config: PrivateReplicaConfig, key: string): boolean
  prepare(): Promise<void>
  reload(session: DeliverySession): Promise<void>
  provision(session: DeliverySession): Promise<string[]>
  runBoard(config: BlindReplicaConfig, current: BindingCurrent): Promise<string | undefined>
  runProfile(config: IdentityReplicaConfig, current: BindingCurrent): Promise<string | undefined>
  maintainWriters(session: DeliverySession): void
  catchingUp(): boolean
  begin(boardOnly: boolean): void
  end(): void
  report(failures: readonly string[], boardOnly: boolean): void
  fail(cause: unknown, session: DeliverySession): void
  afterFullPass(session: DeliverySession): void
}

const backgroundLimit = 2

type ScopeTask = { key: string; run: () => Promise<void>; settle: PromiseWithResolvers<void> }
type ScopeScheduler = ReturnType<typeof createScopeScheduler>
type PassContext = {
  host: RustyDeliveryHost
  scheduler: ScopeScheduler
  requested: Set<string>
  changed: Set<string>
  backgroundTurn: { n: number }
  bindScope(deliver: ScopeDeliver | undefined): void
}

/** Board reads and full Identity passes share one binding queue. */
function createRustyDelivery(host: RustyDeliveryHost) {
  const scheduler = createScopeScheduler(backgroundLimit)
  const followUp = createReplicationFollowUp()
  const requested = new Set<string>()
  const changed = new Set<string>()
  const backgroundTurn = { n: 0 }
  let pending: DeliverySession | undefined
  let running: Promise<void> | undefined
  let deliverScope: ScopeDeliver | undefined
  const pass = (): PassContext => ({
    host, scheduler, requested, changed, backgroundTurn, bindScope: deliver => { deliverScope = deliver },
  })

  function note(workspaceId: string, didChange: boolean) {
    const session = host.capture()
    if (pending && (pending.owner !== session.owner || pending.epoch !== session.epoch)) {
      requested.clear()
      changed.clear()
    }
    pending = session
    requested.add(workspaceId)
    if (didChange) changed.add(workspaceId)
  }

  function retire() {
    pending = undefined
    requested.clear()
    changed.clear()
  }

  function deliverBoard(intent: { workspaceId: string; changed: boolean }): Promise<void> {
    if (!intent.workspaceId) return deliverFull(false)
    if (host.accessReserved()) {
      note(intent.workspaceId, intent.changed)
      return Promise.resolve()
    }
    if (deliverScope) return deliverScope(intent.workspaceId, intent.changed)
    note(intent.workspaceId, intent.changed)
    return running ?? start(false, "board")
  }

  function deliverFull(duringAction = false) {
    return start(duringAction, "full")
  }

  function releaseReservation() {
    const session = pending
    if (!session || requested.size === 0 || host.accessReserved() || !host.matches(session)) {
      if (session && !host.matches(session)) retire()
      return
    }
    void start(false, "board")
  }

  function start(duringAction: boolean, mode: "board" | "full"): Promise<void> {
    if (running) {
      if (mode === "full") followUp.request()
      return running
    }
    if (!host.canStart(duringAction)) return Promise.resolve()
    const boardOnly = mode === "board"
    const session = host.capture()
    host.begin(boardOnly)
    const task = runDeliveryPass(pass(), session, boardOnly).catch(cause => { host.fail(cause, session) }).finally(() => {
      deliverScope = undefined
      running = undefined
      host.end()
      const retry = followUp.next(!boardOnly && host.catchingUp())
      const pendingBoard = requested.size > 0 && !host.accessReserved()
      if (!boardOnly && host.matches(session)) host.afterFullPass(session)
      if (!host.matches(session)) return
      if (retry) void start(false, "full")
      else if (pendingBoard) void start(false, "board")
    })
    running = task
    return task
  }

  return { deliverBoard, deliverFull, releaseReservation, retire, currentPass: () => running ?? Promise.resolve() }
}

async function runDeliveryPass(pass: PassContext, session: DeliverySession, boardOnly: boolean) {
  const { host } = pass
  if (!host.matches(session)) return
  await host.prepare()
  if (!host.matches(session)) return
  if (!boardOnly && host.boards().length + host.profiles().length === 0) await host.reload(session)
  const failures: string[] = []
  const started = new Set<string>()
  const inflight = new Set<Promise<void>>()
  const queueBoard = (config: BlindReplicaConfig, background: boolean, follow: boolean) =>
    rememberScope(inflight, enqueueBinding(pass, failures, started, session, config, background, follow,
      current => host.runBoard(config, current)))
  const followIds = new Set(pass.changed)
  const foreground = new Set(boardOnly ? pass.requested : [host.activeWorkspaceId(), ...pass.requested])
  pass.requested.clear()
  pass.changed.clear()
  pass.bindScope((workspaceId, didChange) => openBoard(host, session, foreground, followIds, queueBoard, workspaceId, didChange))
  const installed = [...host.boards()]
  const activeTasks = installed.filter(config => foreground.has(config.workspaceId))
    .map(config => queueBoard(config, false, followIds.has(config.workspaceId)))
  const otherTasks = boardOnly ? [] : rotateBackground(installed.filter(config => !foreground.has(config.workspaceId)), pass.backgroundTurn.n++)
    .map(config => queueBoard(config, true, followIds.has(config.workspaceId)))
  if (!boardOnly) await provisionFirst(host, session, failures, activeTasks, otherTasks)
  const identityTasks = boardOnly ? [] : host.profiles().map(config => rememberScope(inflight,
    enqueueBinding(pass, failures, started, session, config, true, false, current => host.runProfile(config, current))))
  await Promise.all([...activeTasks, ...otherTasks, ...identityTasks])
  await drainScopes(inflight)
  if (!host.matches(session)) return
  if (boardOnly) {
    host.report(failures, true)
    return
  }
  await host.reload(session)
  const appeared = host.boards().filter(config => !started.has(host.bindingKey(config, session)))
  await Promise.all(appeared.map(config => queueBoard(config, !foreground.has(config.workspaceId), followIds.has(config.workspaceId))))
  await drainScopes(inflight)
  if (!host.matches(session)) return
  host.maintainWriters(session)
  host.report(failures, false)
}

function enqueueBinding(pass: PassContext, failures: string[], started: Set<string>, session: DeliverySession, config: PrivateReplicaConfig,
  background: boolean, follow: boolean, run: (current: BindingCurrent) => Promise<string | undefined>) {
  const key = pass.host.bindingKey(config, session)
  started.add(key)
  const current = () => pass.host.matches(session) && pass.host.installed(config, key)
  return pass.scheduler.enqueue(key, background, async () => {
    if (!current()) return
    const message = await run(current)
    if (message) failures.push(message)
  }, follow)
}

async function openBoard(host: RustyDeliveryHost, session: DeliverySession, foreground: Set<string>, followIds: Set<string>,
  queueBoard: (config: BlindReplicaConfig, background: boolean, follow: boolean) => Promise<void>, workspaceId: string, didChange: boolean) {
  if (!host.matches(session)) return
  foreground.add(workspaceId)
  if (didChange) followIds.add(workspaceId)
  await Promise.all(host.boards().filter(config => config.workspaceId === workspaceId && !config.removalPending)
    .map(config => queueBoard(config, false, didChange)))
}

async function provisionFirst(host: RustyDeliveryHost, session: DeliverySession, failures: string[], active: Promise<void>[], other: Promise<void>[]) {
  try { failures.push(...await host.provision(session)) }
  catch (cause) {
    await Promise.allSettled([...active, ...other])
    throw cause
  }
}

/** Drop a finished read immediately so one stalled binding cannot retain every later board. */
function rememberScope(inflight: Set<Promise<void>>, task: Promise<void>) {
  if (inflight.has(task)) return task
  inflight.add(task)
  void task.then(() => { inflight.delete(task) }, () => { inflight.delete(task) })
  return task
}

async function drainScopes(inflight: Set<Promise<void>>) {
  while (inflight.size) await Promise.all([...inflight])
}

function rotateBackground<T>(items: T[], turn: number): T[] {
  if (items.length < 2) return items
  const offset = turn % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

/** A queued binding can move ahead of blocked background work. One newer read waits; a selection joins the current read. */
function createScopeScheduler(limit: number) {
  const scheduled = new Map<string, ScopeTask>()
  const followUp = new Map<string, () => Promise<void>>()
  const waiting: ScopeTask[] = []
  let active = 0
  function start(task: ScopeTask, background: boolean) {
    if (background) active += 1
    void (async () => {
      let failure: unknown
      const once = async (run: () => Promise<void>) => {
        try { await run() } catch (cause) { failure = cause }
      }
      try {
        await once(task.run)
        for (;;) {
          const next = followUp.get(task.key)
          if (!next) break
          followUp.delete(task.key)
          failure = undefined
          await once(next)
        }
        if (failure) task.settle.reject(failure)
        else task.settle.resolve()
      } finally {
        scheduled.delete(task.key)
        if (background) active -= 1
        while (active < limit && waiting.length) start(waiting.shift()!, true)
      }
    })()
  }
  return {
    enqueue(key: string, background: boolean, run: () => Promise<void>, follow = false): Promise<void> {
      const existing = scheduled.get(key)
      if (existing) return replaceScheduled(existing, waiting, followUp, start, background, follow, run)
      const settle = Promise.withResolvers<void>()
      const task = { key, run, settle }
      scheduled.set(key, task)
      if (background && active >= limit) waiting.push(task)
      else start(task, background)
      return settle.promise
    },
  }
}

function replaceScheduled(existing: ScopeTask, waiting: ScopeTask[], followUp: Map<string, () => Promise<void>>,
  start: (task: ScopeTask, background: boolean) => void, background: boolean, follow: boolean, run: () => Promise<void>) {
  const index = waiting.indexOf(existing)
  if (index >= 0) {
    existing.run = run
    if (!background || follow) {
      waiting.splice(index, 1)
      start(existing, false)
    }
  } else if (follow) followUp.set(existing.key, run)
  return existing.settle.promise
}

type ReplicaRuntime = ReturnType<typeof createPrivateReplicaRuntime>
type Freshness = ReturnType<typeof createBoardFreshness>
type HealthRun = { recordReplicaHealth: typeof recordReplicaHealth; createBoardFreshness: typeof createBoardFreshness }

type RustyDeliveryInput = {
  state: PrivateReplicationState
  activeWorkspaceId: () => string
  freshness: Ref<Freshness | undefined>
  capture: () => DeliverySession
  live: (owner: string, epoch: number) => boolean
  reserved: () => boolean
  replica: ReplicaRuntime["replica"]
  revoke: (config: BlindReplicaConfig) => Promise<unknown>
  reload: (owner: string, epoch: number) => Promise<void>
  provision: (owner: string, epoch: number) => Promise<string[]>
  maintainWriters: (owner: string, epoch: number) => void
  afterFullPass: (owner: string, epoch: number) => void
  hasConfiguredWork: () => boolean
}

export function createConfiguredRustyDelivery(input: RustyDeliveryInput) {
  const { state } = input
  let recorded: HealthRun | undefined
  const health = async () => {
    recorded ??= await import("./replicaHealthRun")
    input.freshness.value ??= recorded.createBoardFreshness(state.configs, state.now, () => input.capture().owner, input.activeWorkspaceId)
    return recorded
  }
  const matches = (session: DeliverySession) => input.live(session.owner, session.epoch)
  return createRustyDelivery({
    capture: input.capture, matches, accessReserved: input.reserved,
    canStart: duringAction => !state.busy.value && (!input.reserved() || duringAction) && matches(input.capture()) && Boolean(input.capture().owner) && input.hasConfiguredWork(),
    activeWorkspaceId: input.activeWorkspaceId,
    boards: () => state.configs.value, profiles: () => state.identityConfigs.value,
    bindingKey: (config, session) => privateReplicaOperationKey(session.owner, session.epoch, config),
    installed: (config, key) => installedBinding(state.configs.value, state.identityConfigs.value, input.capture(), config, key),
    prepare: async () => { await health() },
    reload: session => input.reload(session.owner, session.epoch),
    provision: session => input.provision(session.owner, session.epoch),
    maintainWriters: session => { input.maintainWriters(session.owner, session.epoch) },
    catchingUp: () => Object.values(state.statuses.value).some(status => status.phase === "catching-up"),
    begin: boardOnly => { beginDeliveryPass(state, boardOnly) },
    end: () => { state.busy.value = false },
    report: (failures, boardOnly) => { reportDeliveryPass(state, failures, boardOnly) },
    fail: (cause, session) => { if (matches(session)) reportDeviceSyncProblem(input.state, cause) },
    afterFullPass: session => { input.afterFullPass(session.owner, session.epoch) },
    runBoard: (config, current) => readBoard(health, input, config, current),
    runProfile: (config, current) => readProfile(health, input, config, current),
  })
}

function installedBinding(boards: readonly PrivateReplicaConfig[], profiles: readonly PrivateReplicaConfig[], session: DeliverySession, config: PrivateReplicaConfig, key: string) {
  const list = config.purpose === "identity" ? profiles : boards
  return list.some(candidate => privateReplicaOperationKey(session.owner, session.epoch, candidate) === key)
}

function beginDeliveryPass(state: PrivateReplicationState, boardOnly: boolean) {
  state.busy.value = true
  if (boardOnly) return
  state.error.value = ""; state.notice.value = ""
  state.deviceSyncIssues.value = Object.fromEntries(Object.entries(state.deviceSyncIssues.value).filter(([key]) => key !== "session"))
}

function reportDeliveryPass(state: PrivateReplicationState, failures: readonly string[], boardOnly: boolean) {
  if (failures.length) state.error.value = failures.join("; ")
  else if (!boardOnly && !Object.keys(state.deviceSyncIssues.value).length) state.notice.value = "Configured encrypted replicas synchronized."
}

async function readBoard(health: () => Promise<HealthRun>, input: RustyDeliveryInput, config: BlindReplicaConfig, current: () => boolean) {
  const module = await health()
  const checks = input.freshness.value
  if (!checks) return
  const message = await module.recordReplicaHealth(config, input.state.statuses, async () => {
    if (config.removalPending) { await input.revoke(config); return }
    return checks.check(config, current, async observeRead => (await input.replica(config)).sync(observeRead))
  }, current, input.state.deviceSyncIssues)
  return message && `Board (${new URL(config.origin).host}): ${message}`
}

async function readProfile(health: () => Promise<HealthRun>, input: RustyDeliveryInput, config: IdentityReplicaConfig, current: () => boolean) {
  const module = await health()
  const message = await module.recordReplicaHealth(config, input.state.statuses, async () => {
    if (config.removalPending) throw new Error("Private connection removal is pending")
    try { return await (await input.replica(config)).sync() }
    catch (cause) {
      if (current() && requiresRustyPermissionMigration(cause)) input.state.profilePermissionUpdates.value = [...new Set([...input.state.profilePermissionUpdates.value, config.origin])]
      throw cause
    }
  }, current, input.state.deviceSyncIssues)
  return message && `Profile (${new URL(config.origin).host}): ${message}`
}
