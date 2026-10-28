import { computed, onScopeDispose, ref, watch } from "vue"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { withPublicBoardOrigin } from "../public/publicBoardLink"
import { boardRouteUrl } from "./boardRoute"
import type * as AccessOperations from "./publicBoardAccessOperations"
import { PublicBoardSourceChangedError, type PublicBoardAccessInput, type PublicBoardAccessOperations } from "./publicBoardAccessInput"

export type { PublicBoardAccessInput } from "./publicBoardAccessInput"

export function usePublicBoardAccess(input: PublicBoardAccessInput) {
  const checked = ref(false), published = ref(false), busy = ref(false), error = ref(""), revision = ref(0), withdrawn = ref(false), recoveryNeeded = ref(false)
  const syncPending = ref(false)
  const progress = ref<PublicBoardAccessOperations["progress"]["value"]>(null)
  const lastConfirmedAt = ref<number | null>(null)
  const lastDelivery = ref<PublicBoardAccessOperations["lastDelivery"]["value"]>(null)
  const availability = ref<"published" | "withdrawn" | "missing" | "unknown">("unknown")
  const state: PublicBoardAccessOperations["state"] = { generation: 0, syncQueued: false, operationRunning: false,
    refreshQueued: false, disposed: false, deliveryGeneration: null, deliveryPolicyHash: null, deliveryPolicyContentHash: null, retryCount: 0, lastHash: "", policyCache: {} }
  const timers: PublicBoardAccessOperations["timers"] = {}
  const currentBoardId = () => input.boardId() ?? ""
  const link = computed(() => published.value && currentBoardId() && input.origin() ? withPublicBoardOrigin(boardRouteUrl(currentBoardId(), input.boardTitle()), input.origin()) : "")
  const capture: PublicBoardAccessOperations["capture"] = (options = {}) => {
    const origin = input.origin()
    const boardId = currentBoardId(), workspaceId = input.workspaceId(), profile = input.profile(), document = input.document()
    if (!input.owner() || !boardId || !workspaceId || !profile || !document) throw new Error("Current owner, board, or workspace data is unavailable")
    if (!origin) throw new Error("Connect Rusty to this board to enable public access.")
    const requireConnection = options.requireConnection !== false
    if (requireConnection && !input.connected()) throw new Error("Reconnect this board to its Rusty before publishing changes.")
    const generation = state.generation
    const ownerBinding = ownerAuthorityBinding(profile)
    const sourceVersion = input.sourceVersion(), sourceHeads = [...input.sourceHeads()].sort()
    return { origin, boardId, workspaceId, profile, document, sourceVersion, sourceHeads,
      ensureCurrent: () => {
        if (state.disposed || state.generation !== generation) throw new Error("Owner board operation is no longer current")
        if (input.origin() !== origin || requireConnection && !input.connected()) throw new Error("Board publication connection changed; retry the action")
        assertCurrent(input, boardId, workspaceId, ownerBinding,
          options.requireUnchangedSource === false ? undefined : sourceHeads)
      } }
  }
  const scheduleSync = (delay = input.debounceMs ?? 350) => {
    if (timers.debounce) clearTimeout(timers.debounce)
    if (!published.value || withdrawn.value || recoveryNeeded.value || !input.owner() || !input.connected()) { syncPending.value = false; return }
    syncPending.value = true
    if (timers.retry) return
    timers.debounce = setTimeout(() => { timers.debounce = undefined; void ctx.deliverLatest() }, delay)
  }
  const scheduleRetry = () => {
    if (timers.retry) clearTimeout(timers.retry)
    const delay = retryDelay(state.retryCount++)
    timers.retry = setTimeout(() => {
      timers.retry = undefined
      void ctx.refresh()
    }, delay)
  }
  type Operations = typeof AccessOperations
  let operations: Operations | undefined
  let loading: Promise<Operations> | undefined
  function run<T>(operation: (loaded: Operations) => Promise<T>): Promise<T> {
    if (operations) return operation(operations)
    loading ??= import("./publicBoardAccessOperations").then(loaded => { operations = loaded; return loaded })
      .catch(cause => { loading = undefined; throw cause })
    return loading.then(operation)
  }
  function refresh() {
    if (!input.owner() || !input.origin() || state.disposed) return Promise.resolve()
    const generation = state.generation
    if (!operations) { busy.value = true; progress.value = { phase: "checking", startedAt: Date.now() } }
    return run(loaded => generation === state.generation ? loaded.refreshPublicAccess(ctx) : Promise.resolve()).catch(cause => {
      if (generation !== state.generation || state.disposed) return
      checked.value = false; busy.value = false; progress.value = null
      error.value = cause instanceof Error ? cause.message : "Could not load public board controls. Reload the app and retry."
      scheduleRetry()
    })
  }
  const ctx: PublicBoardAccessOperations = { input, availability, checked, published, busy, error, revision, withdrawn, recoveryNeeded, syncPending, progress, lastConfirmedAt, lastDelivery, state, timers, capture, scheduleSync, scheduleRetry,
    refresh, deliverLatest: () => run(loaded => loaded.deliverLatestPublicSnapshot(ctx)) }

  watch(() => `${input.owner()}:${sourceIdentity(input)}`, () => {
    resetAccess(ctx)
    stopTimer(timers.status)
    timers.status = undefined
    if (input.owner() && input.origin()) {
      void ctx.refresh()
      timers.status = setInterval(() => { if (input.owner()) void ctx.refresh() }, 15_000)
    }
  }, { immediate: true })
  watch(() => input.connected(), connected => {
    if (connected) { if (input.owner() && input.origin()) void ctx.refresh() }
    else { state.syncQueued = false; syncPending.value = false; clearTimer(timers.debounce); timers.debounce = undefined }
  })
  watch(() => input.sourceVersion(), () => {
    if (published.value && !withdrawn.value && input.owner()) {
      state.syncQueued = true
      if (!state.operationRunning) scheduleSync()
    }
  })
  onScopeDispose(() => { state.disposed = true; state.generation++; syncPending.value = false; clearTimers(timers) })
  return { owner: computed(() => input.owner()), origin: computed(input.origin), connected: computed(() => input.connected()), checked, published, busy, error, revision, link, progress, lastConfirmedAt, lastDelivery,
    syncPending, privateConfirmed: computed(() => checked.value && availability.value !== "published" && availability.value !== "unknown"),
    refresh: ctx.refresh, retry: () => run(loaded => loaded.retryPublicAccess(ctx)),
    setPublic: (enabled: boolean) => {
      if (operations) return operations.changePublicAccess(ctx, enabled)
      error.value = "Public access is not ready for changes"
      return Promise.reject(new Error(error.value))
    }, withdrawn, recoveryNeeded }
}

function ownerAuthorityBinding(profile: LocalProfile) {
  return canonicalizeJson([profile.identity.personId, profile.identity.publicKey ?? null,
    profile.device.deviceId, profile.device.publicKey ?? null, profile.certificate ?? null])
}
function assertCurrent(input: PublicBoardAccessInput, boardId: string, workspaceId: string, ownerBinding: string,
  sourceHeads?: string[]) {
  const currentProfile = input.profile()
  if (!input.owner() || input.workspaceId() !== workspaceId || (input.boardId() ?? "") !== boardId ||
      !currentProfile || ownerAuthorityBinding(currentProfile) !== ownerBinding) {
    throw new Error("Board access or owner identity changed; retry the action")
  }
  // Projection invalidation also covers identity presentation; admitted heads bind workspace contents.
  if (sourceHeads && canonicalizeJson([...input.sourceHeads()].sort()) !== canonicalizeJson(sourceHeads)) {
    throw new PublicBoardSourceChangedError()
  }
}
function sourceIdentity(input: PublicBoardAccessInput) {
  const profile = input.profile()
  return `${input.origin()}:${input.workspaceId()}:${input.boardId() ?? ""}:${profile?.identity.personId ?? ""}:${profile?.device.deviceId ?? ""}`
}
function resetAccess(ctx: PublicBoardAccessOperations) {
  ctx.state.generation++
  ctx.checked.value = false; ctx.published.value = false; ctx.busy.value = false; ctx.error.value = ""; ctx.revision.value = 0; ctx.recoveryNeeded.value = false
  ctx.syncPending.value = false
  ctx.progress.value = null; ctx.lastConfirmedAt.value = null; ctx.lastDelivery.value = null
  ctx.state.deliveryGeneration = null; ctx.state.deliveryPolicyHash = null; ctx.withdrawn.value = false
  ctx.state.deliveryPolicyContentHash = null
  ctx.availability.value = "unknown"
  ctx.state.syncQueued = false; ctx.state.lastHash = ""
  ctx.state.projectionComparison = undefined; ctx.state.policyCache = {}
  clearTimer(ctx.timers.debounce); clearTimer(ctx.timers.retry)
  ctx.timers.debounce = undefined; ctx.timers.retry = undefined
}
function retryDelay(attempt: number) { return [2_000, 5_000, 15_000, 30_000, 60_000][Math.min(attempt, 4)]! }
function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) { if (timer) clearTimeout(timer) }
function stopTimer(timer: ReturnType<typeof setInterval> | undefined) { if (timer) clearInterval(timer) }
function clearTimers(timers: PublicBoardAccessOperations["timers"]) {
  clearTimer(timers.debounce); clearTimer(timers.retry); stopTimer(timers.status)
}
