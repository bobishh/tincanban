import type { Ref } from "vue"
import type { LocalProfile } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { PublicBoardDeliveryPolicyCache, PublicBoardDeliveryPolicyEvidence } from "../public/publicDeliveryPolicy"
import { canonicalizeJson, sha256Base64Url } from "../domain/identity"
import { deleteLocal, readLocal, writeLocal } from "../localDb"
import { createBrowserBoardPublication } from "./publicBoardPublication"
import { parsePublicationRecord, publicationRecordKey, reconcilePublicationRecord, type PublicationIntentAction, type PublicationRecord } from "../domain/publicationState"

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
  checked: Ref<boolean>; published: Ref<boolean>; busy: Ref<boolean>; error: Ref<string>; revision: Ref<number>; withdrawn: Ref<boolean>; recoveryNeeded: Ref<boolean>; syncPending: Ref<boolean>
  state: { generation: number; syncQueued: boolean; operationRunning: boolean; refreshQueued: boolean; disposed: boolean;
    deliveryGeneration: number | null; deliveryPolicyHash: string | null; deliveryPolicyContentHash: string | null; retryCount: number; lastHash: string;
    projectionComparison?: string; policyCache: PublicBoardDeliveryPolicyCache; remoteAvailability: "published" | "withdrawn" | "missing" | "unknown" }
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
    await applyOwnerStatus(ctx, captured)
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
async function applyOwnerStatus(ctx: PublicBoardAccessOperations, captured: Awaited<ReturnType<typeof readOwnerStatus>>) {
  const status = captured.status
  const key = publicationRecordKey(ctx.input.origin, captured.workspaceId, captured.boardId, captured.profile)
  let record = parsePublicationRecord(await readLocal(key))
  if (!record && status.published) record = { version: 1, origin: ctx.input.origin, workspaceId: captured.workspaceId,
    boardId: captured.boardId, ownerPersonId: captured.profile.identity.personId, ownerIntent: "published",
    confirmedRevision: status.revision, confirmedHash: status.hash ?? "", confirmedProjection: status.projection,
    remoteAvailability: "published" }
  const reconciled = reconcilePublicationRecord(record, status)
  if (reconciled.record) await writeLocal(key, JSON.stringify(reconciled.record))
  ctx.checked.value = true
  ctx.published.value = reconciled.published
  ctx.revision.value = reconciled.revision
  ctx.state.deliveryGeneration = status.deliveryGeneration ?? null
  ctx.state.deliveryPolicyHash = status.deliveryPolicyHash ?? null
  ctx.state.deliveryPolicyContentHash = status.deliveryPolicyContentHash ?? null
  ctx.state.lastHash = reconciled.hash
  ctx.state.remoteAvailability = status.availability ?? (status.published ? "published" : "withdrawn")
  ctx.withdrawn.value = reconciled.withdrawn
  ctx.recoveryNeeded.value = reconciled.recoveryNeeded
  ctx.state.syncQueued = reconciled.published && !reconciled.recoveryNeeded
  if (ctx.state.syncQueued) ctx.scheduleSync()
  else {
    ctx.syncPending.value = false
    if (ctx.timers.debounce) { clearTimeout(ctx.timers.debounce); ctx.timers.debounce = undefined }
  }
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
  const intent = await persistPublicationIntent(ctx, captured, "publish", expectedRevision, deliveryPolicy)
  const result = await publishBoardSnapshot({ origin: ctx.input.origin, ...captured, action: "publish", expectedRevision, deliveryPolicy,
    preparedProjection: intent.record.intent?.projection ?? undefined, preparedProjectionHash: intent.record.intent?.projectionHash,
    preparedAssetManifest: intent.record.intent?.preparedAssetManifest, preparedAssets: intent.preparedAssets ?? [] })
  captured.ensureCurrent()
  if (generation !== ctx.state.generation) return
  await confirmPublicationIntent(ctx, captured, intent, result)
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
  const intent = await persistPublicationIntent(ctx, captured, "unpublish", expectedRevision)
  const result = await withdrawPublicBoard({ origin: ctx.input.origin, boardId: captured.boardId,
    profile: captured.profile, expectedRevision, ensureCurrent: captured.ensureCurrent })
  captured.ensureCurrent()
  if (generation !== ctx.state.generation) return
  await confirmPublicationIntent(ctx, captured, intent, result)
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
  ctx.syncPending.value = true
  await ctx.deliverLatest()
}

export async function deliverLatestPublicSnapshot(ctx: PublicBoardAccessOperations) {
  if (!canStartPublicDelivery(ctx)) {
    if (!ctx.state.syncQueued || !ctx.published.value || ctx.withdrawn.value || ctx.recoveryNeeded.value || !ctx.input.owner()) ctx.syncPending.value = false
    return
  }
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
    else ctx.syncPending.value = false
  }
}
function retainPublicDeliveryForRetry(ctx: PublicBoardAccessOperations, cause: unknown) {
  ctx.state.syncQueued = true
  ctx.syncPending.value = true
  if (cause instanceof PublicBoardSourceChangedError) return
  ctx.error.value = cause instanceof Error ? cause.message : "Public delivery failed"
  ctx.scheduleRetry()
}
async function hasProjectionChanged(ctx: PublicBoardAccessOperations, captured: CapturedAccessSource) {
  const [{ hasLocalPublicBoardChanges }, { readChatContentRevision }] = await Promise.all([
    import("../public/publicationClient"), import("../chat/service")])
  const chatRevision = await readChatContentRevision(captured.workspaceId)
  const fingerprintParts = [captured.workspaceId, captured.boardId, captured.sourceHeads, chatRevision, ctx.state.lastHash, ctx.revision.value]
  const fingerprint = canonicalizeJson(fingerprintParts)
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
  const intent = await persistPublicationIntent(ctx, captured, "update", ctx.revision.value, deliveryPolicy)
  const result = await publishBoardSnapshot({ origin: ctx.input.origin, ...captured, action: "update",
    expectedRevision: ctx.revision.value, ensureCurrent: captured.ensureCurrent, deliveryPolicy,
    preparedProjection: intent.record.intent?.projection ?? undefined, preparedProjectionHash: intent.record.intent?.projectionHash,
    preparedAssetManifest: intent.record.intent?.preparedAssetManifest, preparedAssets: intent.preparedAssets ?? [] })
  captured.ensureCurrent()
  if (generation !== ctx.state.generation || ctx.withdrawn.value) return
  await confirmPublicationIntent(ctx, captured, intent, result)
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
  return ctx.state.syncQueued && !ctx.state.operationRunning && ctx.published.value && !ctx.withdrawn.value &&
    !ctx.recoveryNeeded.value && ctx.state.remoteAvailability !== "missing" && ctx.input.owner()
}

async function persistPublicationIntent(ctx: PublicBoardAccessOperations, captured: CapturedAccessSource, action: PublicationIntentAction,
  expectedRevision: number, deliveryPolicy?: PublicBoardDeliveryPolicyEvidence): Promise<{ key: string; record: PublicationRecord; preparedAssets?: Array<{ sha256: string; bytes: Uint8Array }> }> {
  const key = publicationRecordKey(ctx.input.origin, captured.workspaceId, captured.boardId, captured.profile)
  const current = parsePublicationRecord(await readLocal(key))
  assertNoUncertainPublicationIntent(current)
  const publication = action === "unpublish" ? undefined : await createBrowserBoardPublication(captured.document, captured.workspaceId, captured.boardId)
  const projection = publication ? jsonProjection(publication.projection) : null
  const projectionHash = await sha256Base64Url(new TextEncoder().encode(projection ? canonicalizeJson(projection) : "null"))
  const intent = { operationId: crypto.randomUUID(), action, expectedRevision, projection, projectionHash,
    ...(publication ? { preparedAssetManifest: publication.assets.map(asset => ({ sha256: asset.sha256, byteLength: asset.bytes.byteLength })) } : {}),
    sourceHeads: [...captured.sourceHeads], ...(deliveryPolicy ? { deliveryPolicy: structuredClone(deliveryPolicy) } : {}) }
  const record = createPendingPublicationRecord(ctx, captured, action, expectedRevision, intent, current)
  captured.ensureCurrent()
  await writeLocal(key, JSON.stringify(record))
  try { captured.ensureCurrent() } catch (cause) {
    const saved = parsePublicationRecord(await readLocal(key))
    if (saved?.intent?.operationId === intent.operationId) await deleteLocal(key)
    throw cause
  }
  return { key, record, ...(publication ? { preparedAssets: publication.assets } : {}) }
}

function jsonProjection<T>(projection: T): T {
  return JSON.parse(JSON.stringify(projection)) as T
}

function assertNoUncertainPublicationIntent(current: PublicationRecord | undefined) {
  if (current?.intent && !current.intent.confirmed) throw new Error("A previous publication operation has uncertain outcome; refresh status before changing access")
}
function createPendingPublicationRecord(ctx: PublicBoardAccessOperations, captured: CapturedAccessSource, action: PublicationIntentAction,
  expectedRevision: number, intent: NonNullable<PublicationRecord["intent"]>, current?: PublicationRecord): PublicationRecord {
  return { version: 1, origin: ctx.input.origin, workspaceId: captured.workspaceId, boardId: captured.boardId,
    ownerPersonId: captured.profile.identity.personId, ownerIntent: action === "unpublish" ? "withdrawn" : "published",
    intent, ...(current?.receipt ? { receipt: current.receipt } : {}), confirmedRevision: current?.confirmedRevision ?? expectedRevision,
    confirmedHash: current?.confirmedHash ?? ctx.state.lastHash, remoteAvailability: ctx.state.remoteAvailability }
}

async function confirmPublicationIntent(ctx: PublicBoardAccessOperations, captured: CapturedAccessSource,
  pending: { key: string; record: PublicationRecord }, result: { revision: number; hash?: string; receipt?: unknown }) {
  captured.ensureCurrent()
  const confirmedIntent = pending.record.intent ? { ...pending.record.intent, confirmed: true,
    confirmedBy: result.receipt ? "receipt" as const : pending.record.intent.confirmedBy } : undefined
  const confirmed: PublicationRecord = { ...pending.record, ownerIntent: pending.record.intent?.action === "unpublish" ? "withdrawn" : "published",
    intent: confirmedIntent,
    ...(result.receipt ? { receipt: result.receipt as PublicationRecord["receipt"] } : {}), confirmedRevision: result.revision,
    confirmedHash: result.hash ?? pending.record.intent?.projectionHash ?? pending.record.confirmedHash,
    ...(pending.record.intent?.projection ? { confirmedProjection: pending.record.intent.projection } : {}),
    remoteAvailability: pending.record.intent?.action === "unpublish" ? "withdrawn" : "published" }
  await writeLocal(pending.key, JSON.stringify(confirmed))
}
