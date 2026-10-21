import type { Ref } from "vue"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { PublicBoardDeliveryPolicyCache, PublicBoardDeliveryPolicyEvidence } from "../public/publicDeliveryPolicy"
import { canonicalizeJson } from "../domain/identity"

export class PublicBoardSourceChangedError extends Error {
  constructor() { super("Board source changed during publication preparation") }
}

export interface PublicBoardAccessInput {
  origin: string
  boardId: () => string | null | undefined
  boardTitle: () => string
  workspaceId: () => string
  document: () => WorkspaceDocumentV2 | null | undefined
  sourceVersion: () => number
  sourceHeads: () => string[]
  owner: () => boolean
  profile: () => LocalProfile | null | undefined
  debounceMs?: number
}
export type CapturedAccessSource = {
  boardId: string; workspaceId: string; profile: LocalProfile; document: WorkspaceDocumentV2
  sourceVersion: number; sourceHeads: string[]; ensureCurrent: () => void
}
export type PublicBoardAccessOperations = {
  input: PublicBoardAccessInput
  checked: Ref<boolean>; published: Ref<boolean>; busy: Ref<boolean>; error: Ref<string>; revision: Ref<number>; withdrawn: Ref<boolean>
  state: { generation: number; syncQueued: boolean; operationRunning: boolean; refreshQueued: boolean; disposed: boolean;
    deliveryGeneration: number | null; deliveryPolicyHash: string | null; deliveryPolicyContentHash: string | null; retryCount: number; lastHash: string;
    projectionComparison?: string; policyCache: PublicBoardDeliveryPolicyCache }
  timers: { debounce?: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setTimeout>; status?: ReturnType<typeof setInterval> }
  capture: (options?: { requireUnchangedSource?: boolean }) => CapturedAccessSource
  scheduleSync: (delay?: number) => void
  scheduleRetry: () => void
  refresh: () => Promise<void>
  deliverLatest: () => Promise<void>
}

export async function refreshPublicAccess(ctx: PublicBoardAccessOperations) {
  if (!ctx.input.owner() || ctx.state.disposed) return
  if (ctx.state.operationRunning) { ctx.state.refreshQueued = true; return }
  const generation = ctx.state.generation
  ctx.state.operationRunning = true
  ctx.busy.value = true
  ctx.error.value = ""
  try {
    const captured = await readOwnerStatus(ctx)
    captured.ensureCurrent()
    if (generation !== ctx.state.generation) return
    applyOwnerStatus(ctx, captured)
  } catch (cause) {
    if (generation === ctx.state.generation) {
      ctx.checked.value = false
      ctx.error.value = cause instanceof Error ? cause.message : "Public access status unavailable"
      ctx.scheduleRetry()
    }
  } finally {
    ctx.state.operationRunning = false
    if (generation === ctx.state.generation) ctx.busy.value = false
    if (ctx.state.syncQueued && generation === ctx.state.generation && !ctx.error.value) ctx.scheduleSync()
    if (ctx.state.refreshQueued && ctx.input.owner() && !ctx.state.disposed) {
      ctx.state.refreshQueued = false
      queueMicrotask(() => { void ctx.refresh() })
    }
  }
}
async function readOwnerStatus(ctx: PublicBoardAccessOperations) {
  if (!ctx.input.origin) throw new Error("Public board access is not configured on this deployment")
  // Reading management status is bound to board/owner, not a visitor snapshot.
  const captured = ctx.capture({ requireUnchangedSource: false })
  const { readPublicBoardManagementState } = await import("../public/publicationClient")
  captured.ensureCurrent()
  const status = await readPublicBoardManagementState({ origin: ctx.input.origin, boardId: captured.boardId,
    profile: captured.profile, ensureCurrent: captured.ensureCurrent })
  return { ...captured, status }
}
function applyOwnerStatus(ctx: PublicBoardAccessOperations, captured: Awaited<ReturnType<typeof readOwnerStatus>>) {
  const status = captured.status
  ctx.checked.value = true
  ctx.published.value = status.published
  ctx.revision.value = status.revision
  ctx.state.deliveryGeneration = status.deliveryGeneration ?? null
  ctx.state.deliveryPolicyHash = status.deliveryPolicyHash ?? null
  ctx.state.deliveryPolicyContentHash = status.deliveryPolicyContentHash ?? null
  ctx.state.lastHash = status.hash ?? ""
  ctx.withdrawn.value = !status.published && status.revision > 0
  ctx.state.syncQueued = status.published
  if (status.published) ctx.scheduleSync()
  else if (ctx.timers.debounce) { clearTimeout(ctx.timers.debounce); ctx.timers.debounce = undefined }
}

export async function changePublicAccess(ctx: PublicBoardAccessOperations, enabled: boolean) {
  if (!ctx.checked.value || !ctx.input.owner()) {
    const error = new Error("Public access is not ready for changes")
    ctx.error.value = error.message
    throw error
  }
  if (ctx.state.operationRunning) {
    const error = new Error("Public access is already being checked or updated. Try again when it finishes.")
    ctx.error.value = error.message
    throw error
  }
  const generation = ctx.state.generation
  ctx.state.operationRunning = true
  ctx.busy.value = true
  ctx.error.value = ""
  try {
    const captured = ctx.capture()
    const expectedRevision = ctx.revision.value
    if (enabled) await enablePublicAccess(ctx, captured, generation, expectedRevision)
    else await disablePublicAccess(ctx, captured, generation, expectedRevision)
  } catch (cause) {
    if (generation === ctx.state.generation) ctx.error.value = cause instanceof Error ? cause.message : "Could not change public access"
    throw cause
  } finally {
    ctx.state.operationRunning = false
    if (generation === ctx.state.generation) ctx.busy.value = false
    if (generation === ctx.state.generation && ctx.state.syncQueued && !ctx.withdrawn.value) ctx.scheduleSync()
  }
}
async function enablePublicAccess(ctx: PublicBoardAccessOperations, captured: CapturedAccessSource, generation: number, expectedRevision: number) {
  captured.ensureCurrent()
  if (ctx.published.value) return
  const [{ buildPublicBoardDeliveryPolicy, publicBoardDeliveryPolicyHash, publicBoardDeliveryPolicyContentHash }, { publishBoardSnapshot }] = await Promise.all([
    import("../public/publicDeliveryPolicy"), import("../public/publicationClient")])
  captured.ensureCurrent()
  const deliveryPolicy = await buildPublicBoardDeliveryPolicy(captured.profile, captured.workspaceId, captured.boardId,
    (ctx.state.deliveryGeneration ?? 0) + 1, captured.ensureCurrent, captured.document, ctx.state.policyCache, captured.sourceVersion)
  captured.ensureCurrent()
  const result = await publishBoardSnapshot({ origin: ctx.input.origin, ...captured, action: "publish", expectedRevision, deliveryPolicy })
  captured.ensureCurrent()
  if (generation !== ctx.state.generation) return
  ctx.revision.value = result.revision
  ctx.state.deliveryGeneration = deliveryPolicy.policy.payload.generation
  ctx.state.deliveryPolicyHash = await publicBoardDeliveryPolicyHash(deliveryPolicy)
  ctx.state.deliveryPolicyContentHash = await publicBoardDeliveryPolicyContentHash(deliveryPolicy)
  ctx.published.value = true
  ctx.withdrawn.value = false
  ctx.state.lastHash = result.hash
}
async function disablePublicAccess(ctx: PublicBoardAccessOperations, captured: CapturedAccessSource, generation: number, expectedRevision: number) {
  captured.ensureCurrent()
  if (!ctx.published.value) return
  const { withdrawPublicBoard } = await import("../public/publicationClient")
  captured.ensureCurrent()
  const result = await withdrawPublicBoard({ origin: ctx.input.origin, boardId: captured.boardId,
    profile: captured.profile, expectedRevision, ensureCurrent: captured.ensureCurrent })
  captured.ensureCurrent()
  if (generation !== ctx.state.generation) return
  ctx.revision.value = result.revision
  ctx.published.value = false
  ctx.withdrawn.value = true
  ctx.state.syncQueued = false
  if (ctx.timers.debounce) clearTimeout(ctx.timers.debounce)
}

export async function retryPublicAccess(ctx: PublicBoardAccessOperations) {
  if (!ctx.checked.value || !ctx.published.value || ctx.withdrawn.value || ctx.state.operationRunning) return ctx.refresh()
  await ctx.refresh()
  if (!ctx.published.value || !ctx.checked.value || ctx.state.operationRunning) return
  if (ctx.timers.debounce) clearTimeout(ctx.timers.debounce)
  ctx.timers.debounce = undefined
  ctx.state.syncQueued = true
  await ctx.deliverLatest()
}

export async function deliverLatestPublicSnapshot(ctx: PublicBoardAccessOperations) {
  if (!canStartPublicDelivery(ctx)) return
  ctx.state.syncQueued = false
  ctx.state.operationRunning = true
  ctx.busy.value = true
  ctx.error.value = ""
  const generation = ctx.state.generation
  try {
    const captured = ctx.capture()
    const sourceVersion = captured.sourceVersion
    const changed = await hasProjectionChanged(ctx, captured)
    captured.ensureCurrent()
    if (generation !== ctx.state.generation || ctx.withdrawn.value) return
    if (sourceVersion !== ctx.input.sourceVersion()) { ctx.state.syncQueued = true; return }
    const policy = await policyIfChanged(ctx, captured)
    if (changed || policy) await publishUpdatedSnapshot(ctx, captured, policy, generation)
    if (sourceVersion !== ctx.input.sourceVersion()) ctx.state.syncQueued = true
  } catch (cause) {
    if (generation === ctx.state.generation) retainPublicDeliveryForRetry(ctx, cause)
  } finally {
    ctx.state.operationRunning = false
    if (generation === ctx.state.generation) ctx.busy.value = false
    if (ctx.state.syncQueued && !ctx.withdrawn.value && !ctx.error.value) ctx.scheduleSync()
  }
}
function retainPublicDeliveryForRetry(ctx: PublicBoardAccessOperations, cause: unknown) {
  ctx.state.syncQueued = true
  if (cause instanceof PublicBoardSourceChangedError) return
  ctx.error.value = cause instanceof Error ? cause.message : "Public delivery failed"
  ctx.scheduleRetry()
}
async function hasProjectionChanged(ctx: PublicBoardAccessOperations, captured: CapturedAccessSource) {
  const [{ hasLocalPublicBoardChanges }, { readChatContentRevision }] = await Promise.all([
    import("../public/publicationClient"), import("../chat/service")])
  const chatRevision = await readChatContentRevision(captured.workspaceId)
  const fingerprint = canonicalizeJson([captured.workspaceId, captured.boardId, captured.sourceVersion,
    captured.sourceHeads, chatRevision, ctx.state.lastHash, ctx.revision.value])
  captured.ensureCurrent()
  if (ctx.state.projectionComparison === fingerprint) return false
  const changed = await hasLocalPublicBoardChanges({ document: captured.document, workspaceId: captured.workspaceId,
    boardId: captured.boardId, hash: ctx.state.lastHash })
  captured.ensureCurrent()
  // File references contain verified content digests. A completed comparison therefore also
  // covers attachment bytes; unavailable files fail above and never create a cache entry.
  if (!changed) ctx.state.projectionComparison = fingerprint
  return changed
}
async function policyIfChanged(ctx: PublicBoardAccessOperations, captured: CapturedAccessSource) {
  const { buildPublicBoardDeliveryPolicy, publicBoardDeliveryPolicyHash, publicBoardDeliveryPolicyContentHash } = await import("../public/publicDeliveryPolicy")
  if (ctx.state.deliveryGeneration === null) {
    return buildPublicBoardDeliveryPolicy(captured.profile, captured.workspaceId, captured.boardId, 1, captured.ensureCurrent, captured.document, ctx.state.policyCache, captured.sourceVersion)
  }
  const current = await buildPublicBoardDeliveryPolicy(captured.profile, captured.workspaceId, captured.boardId,
    ctx.state.deliveryGeneration, captured.ensureCurrent, captured.document, ctx.state.policyCache, captured.sourceVersion)
  const unchanged = ctx.state.deliveryPolicyContentHash !== null
    ? await publicBoardDeliveryPolicyContentHash(current) === ctx.state.deliveryPolicyContentHash
    : await publicBoardDeliveryPolicyHash(current) === ctx.state.deliveryPolicyHash
  if (unchanged) return undefined
  return buildPublicBoardDeliveryPolicy(captured.profile, captured.workspaceId, captured.boardId,
    ctx.state.deliveryGeneration + 1, captured.ensureCurrent, captured.document, ctx.state.policyCache, captured.sourceVersion)
}
async function publishUpdatedSnapshot(ctx: PublicBoardAccessOperations, captured: CapturedAccessSource,
  deliveryPolicy: PublicBoardDeliveryPolicyEvidence | undefined, generation: number) {
  const { publishBoardSnapshot } = await import("../public/publicationClient")
  const result = await publishBoardSnapshot({ origin: ctx.input.origin, ...captured, action: "update",
    expectedRevision: ctx.revision.value, ensureCurrent: captured.ensureCurrent, deliveryPolicy })
  captured.ensureCurrent()
  if (generation !== ctx.state.generation || ctx.withdrawn.value) return
  ctx.revision.value = result.revision
  if (deliveryPolicy) {
    const { publicBoardDeliveryPolicyHash, publicBoardDeliveryPolicyContentHash } = await import("../public/publicDeliveryPolicy")
    ctx.state.deliveryGeneration = deliveryPolicy.policy.payload.generation
    ctx.state.deliveryPolicyHash = await publicBoardDeliveryPolicyHash(deliveryPolicy)
    ctx.state.deliveryPolicyContentHash = await publicBoardDeliveryPolicyContentHash(deliveryPolicy)
  }
  ctx.state.retryCount = 0
  ctx.state.lastHash = result.hash
}
function canStartPublicDelivery(ctx: PublicBoardAccessOperations) {
  return ctx.state.syncQueued && !ctx.state.operationRunning && ctx.published.value && !ctx.withdrawn.value && ctx.input.owner()
}
