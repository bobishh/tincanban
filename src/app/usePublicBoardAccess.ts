import { computed, onScopeDispose, ref, watch } from "vue"
import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { boardRouteUrl } from "./boardRoute"
import { changePublicAccess, deliverLatestPublicSnapshot, refreshPublicAccess, retryPublicAccess,
  type PublicBoardAccessInput, type PublicBoardAccessOperations } from "./publicBoardAccessOperations"

export type { PublicBoardAccessInput } from "./publicBoardAccessOperations"

export function usePublicBoardAccess(input: PublicBoardAccessInput) {
  const checked = ref(false), published = ref(false), busy = ref(false), error = ref(""), revision = ref(0), withdrawn = ref(false)
  const state: PublicBoardAccessOperations["state"] = { generation: 0, syncQueued: false, operationRunning: false,
    refreshQueued: false, disposed: false, deliveryGeneration: null, deliveryPolicyHash: null, deliveryPolicyContentHash: null, retryCount: 0, lastHash: "" }
  const timers: PublicBoardAccessOperations["timers"] = {}
  const currentBoardId = () => input.boardId() ?? ""
  const link = computed(() => published.value && currentBoardId() ? boardRouteUrl(currentBoardId(), input.boardTitle()) : "")
  const capture: PublicBoardAccessOperations["capture"] = (options = {}) => {
    const boardId = currentBoardId(), workspaceId = input.workspaceId(), profile = input.profile(), document = input.document()
    if (!input.owner() || !boardId || !workspaceId || !profile || !document) throw new Error("Current owner, board, or workspace data is unavailable")
    const generation = state.generation
    const sourceVersion = input.sourceVersion(), sourceHeads = [...input.sourceHeads()].sort()
    return { boardId, workspaceId, profile, document, sourceVersion, sourceHeads,
      ensureCurrent: () => {
        if (state.disposed || state.generation !== generation) throw new Error("Owner board operation is no longer current")
        assertCurrent(input, boardId, workspaceId, profile,
          options.requireUnchangedSource === false ? undefined : { version: sourceVersion, heads: sourceHeads })
      } }
  }
  const scheduleSync = (delay = input.debounceMs ?? 350) => {
    if (timers.debounce) clearTimeout(timers.debounce)
    if (!published.value || withdrawn.value || !input.owner()) return
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
  const ctx: PublicBoardAccessOperations = { input, checked, published, busy, error, revision, withdrawn, state, timers, capture, scheduleSync, scheduleRetry,
    refresh: () => refreshPublicAccess(ctx), deliverLatest: () => deliverLatestPublicSnapshot(ctx) }

  watch(() => sourceIdentity(input), () => {
    resetAccess(ctx)
    stopTimer(timers.status)
    timers.status = undefined
    if (input.owner()) {
      void ctx.refresh()
      timers.status = setInterval(() => { if (input.owner()) void ctx.refresh() }, 15_000)
    }
  }, { immediate: true })
  watch(() => input.owner(), owner => {
    if (owner) {
      void ctx.refresh()
      stopTimer(timers.status)
      timers.status = setInterval(() => { if (input.owner()) void ctx.refresh() }, 15_000)
    } else { resetAccess(ctx); stopTimer(timers.status); timers.status = undefined }
  })
  watch(() => input.sourceVersion(), () => {
    if (published.value && !withdrawn.value && input.owner()) { state.syncQueued = true; scheduleSync() }
  })
  onScopeDispose(() => { state.disposed = true; state.generation++; clearTimers(timers) })
  return { owner: computed(() => input.owner()), checked, published, busy, error, revision, link,
    refresh: ctx.refresh, retry: () => retryPublicAccess(ctx), setPublic: (enabled: boolean) => changePublicAccess(ctx, enabled) }
}

function assertCurrent(input: PublicBoardAccessInput, boardId: string, workspaceId: string, profile: LocalProfile,
  source?: { version: number; heads: string[] }) {
  const currentProfile = input.profile()
  if (!input.owner() || input.workspaceId() !== workspaceId || (input.boardId() ?? "") !== boardId ||
      currentProfile?.identity.personId !== profile.identity.personId || currentProfile.device.deviceId !== profile.device.deviceId ||
      source && (input.sourceVersion() !== source.version || canonicalizeJson([...input.sourceHeads()].sort()) !== canonicalizeJson(source.heads))) {
    throw new Error("Board access or owner identity changed; retry the action")
  }
}
function sourceIdentity(input: PublicBoardAccessInput) {
  const profile = input.profile()
  return `${input.workspaceId()}:${input.boardId() ?? ""}:${profile?.identity.personId ?? ""}:${profile?.device.deviceId ?? ""}`
}
function resetAccess(ctx: PublicBoardAccessOperations) {
  ctx.state.generation++
  ctx.checked.value = false; ctx.published.value = false; ctx.busy.value = false; ctx.error.value = ""; ctx.revision.value = 0
  ctx.state.deliveryGeneration = null; ctx.state.deliveryPolicyHash = null; ctx.withdrawn.value = false
  ctx.state.deliveryPolicyContentHash = null
  ctx.state.syncQueued = false; ctx.state.lastHash = ""
  clearTimer(ctx.timers.debounce); clearTimer(ctx.timers.retry)
  ctx.timers.debounce = undefined; ctx.timers.retry = undefined
}
function retryDelay(attempt: number) { return [2_000, 5_000, 15_000, 30_000, 60_000][Math.min(attempt, 4)]! }
function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) { if (timer) clearTimeout(timer) }
function stopTimer(timer: ReturnType<typeof setInterval> | undefined) { if (timer) clearInterval(timer) }
function clearTimers(timers: PublicBoardAccessOperations["timers"]) {
  clearTimer(timers.debounce); clearTimer(timers.retry); stopTimer(timers.status)
}
