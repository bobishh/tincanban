import * as Automerge from "@automerge/automerge/slim"
import { createWorkspaceViewReader } from "./crdtHistory"
import type { LocalProfile } from "./domain/identity"
import { canonicalizeJson } from "./domain/identity"
import type { WorkspaceDocumentV2, WorkspaceEntity } from "./domain/model"
import { assertWorkspaceCapability, assertWorkspaceTransition, type WorkspaceRole } from "./domain/permissions"
import { executeReviewedWorkspaceChange, type ExecuteResult } from "./domain/commands"
import {
  localChangeAuthorityGrantHash,
  workspaceAuthorityIsInvalid,
  workspaceRole,
} from "./sync/changeAuthorization"
import { defaultStorage, type WorkspaceStorage } from "./storage"
import { stateRuntime } from "./stateContext"
import type { WorkspaceTransactionContext } from "./storage"

type CreatedLocalChange = Extract<ExecuteResult, { ok: true }>['value']
export type CausalReviewCallbacks = {
  latestWorkspaceDocument: (workspaceId: string, storage: WorkspaceStorage, transaction: WorkspaceTransactionContext) => Promise<Automerge.Doc<WorkspaceDocumentV2>>
  // Persistence returns `created.newDoc` unchanged when all changes are admitted,
  // otherwise it returns a separately loaded authorized projection.
  persistNewLocalChange: (base: Automerge.Doc<WorkspaceDocumentV2>, created: CreatedLocalChange,
    profile: LocalProfile, storage: WorkspaceStorage, reviewedChangeHash: string | undefined, localRole: WorkspaceRole | undefined,
    transaction: WorkspaceTransactionContext) => Promise<Automerge.Doc<WorkspaceDocumentV2>>
  updateReactiveState: (doc: Automerge.Doc<WorkspaceDocumentV2>) => void
  notifyLocalChanges: (workspaceId?: string) => void
}

export async function refreshCausalReview(storage = defaultStorage, workspaceId = stateRuntime.activeDoc?.id): Promise<void> {
  if (stateRuntime.activeDoc && workspaceId !== stateRuntime.activeDoc.id) return
  if (!workspaceId) {
    stateRuntime.causalReview.value = []
    return
  }
  if (await workspaceAuthorityIsInvalid(workspaceId)) {
    stateRuntime.causalReview.value = []
    stateRuntime.causalReviewError.value = "Workspace authority is unavailable. Showing the last admitted content read-only."
    return
  }
  const evidence = await storage.loadCausalEvidence(workspaceId)
  const reviewable = evidence?.decisions.filter(decision => decision.status.type !== "admitted") ?? []
  if (!evidence || reviewable.length === 0) stateRuntime.causalReview.value = []
  else {
    const raw = Automerge.load<WorkspaceDocumentV2>(evidence.bytes)
    try {
      const changes = new Map(Automerge.getChangesMetaSince(raw, []).map(change => [change.hash, change]))
      const readView = createWorkspaceViewReader(raw)
      const dismissed = new Set(evidence.dismissedHashes ?? [])
      const resolved = resolvedReviewLinks(evidence, raw)
      stateRuntime.causalReview.value = reviewable.map(decision => ({
        ...reviewEntry(readView, decision, changes.get(decision.hash)), dismissed: dismissed.has(decision.hash) || resolved.has(decision.hash),
        resolved: resolved.has(decision.hash),
      }))
    } finally { Automerge.free(raw) }
  }
  stateRuntime.causalReviewError.value = ""
}

export async function setCausalChangeDismissed(changeHash: string, dismissed: boolean, storage = defaultStorage): Promise<void> {
  const workspaceId = stateRuntime.activeDoc?.id
  if (!workspaceId) throw new Error("Workspace not hydrated")
  await storage.withWorkspaceTransaction(workspaceId, async transaction => {
    const evidence = await transaction.loadCausalEvidence()
    const decision = evidence?.decisions.find(item => item.hash === changeHash)
    if (!evidence || !decision || decision.status.type === "admitted") throw new Error("Workspace change history is unavailable")
    const dismissedHashes = new Set(evidence.dismissedHashes ?? [])
    if (dismissed) dismissedHashes.add(changeHash)
    else dismissedHashes.delete(changeHash)
    const loaded = await transaction.loadWorkspaceDoc()
    if (!loaded) throw new Error("Workspace content is unavailable")
    try {
      await transaction.commitWorkspace(loaded.doc, Automerge.save(loaded.doc), [], undefined, {
        ...evidence, dismissedHashes: [...dismissedHashes].sort(),
      })
    } finally { Automerge.free(loaded.doc) }
    if (stateRuntime.activeDoc?.id === workspaceId) await refreshCausalReview(storage, workspaceId)
  })
}

function reviewEntry(readView: ReturnType<typeof createWorkspaceViewReader>, decision: WorkspaceStorageDecision,
  change: ReturnType<typeof Automerge.getChangesMetaSince>[number] | undefined) {
  const transaction = parseTransaction(change?.message)
  let preview: string[] = []
  if (change) {
    try {
      const before = readView(change.deps)
      const candidate = readView([decision.hash])
      // Views share their parent handle; free the raw document once at caller.
      preview = reviewedPatch(before, candidate).preview
    } catch { preview = ["Draft content is available, but its field preview could not be built."] }
  }
  return { hash: decision.hash, status: decision.status as { type: "quarantined" | "pending"; reason: string }, preview,
    actor: change?.actor ?? "Unknown", time: change?.time ?? 0,
    action: typeof transaction.action === "string" ? transaction.action : "Workspace change",
    ...(typeof transaction.personId === "string" ? { personId: transaction.personId } : {}),
    ...(typeof transaction.deviceId === "string" ? { deviceId: transaction.deviceId } : {}) }
}

type WorkspaceStorageDecision = NonNullable<Awaited<ReturnType<WorkspaceStorage["loadCausalEvidence"]>>>["decisions"][number]

export function resolvedReviewLinks(evidence: NonNullable<Awaited<ReturnType<WorkspaceStorage["loadCausalEvidence"]>>>,
  raw: Automerge.Doc<WorkspaceDocumentV2>): Map<string, string> {
  const decisions = new Map(evidence.decisions.map(decision => [decision.hash, decision.status.type]))
  const resolved = new Map((evidence.resolvedReviews ?? []).filter(review =>
    decisions.get(review.sourceHash) === "quarantined" && decisions.get(review.authorizedChangeHash) === "admitted"
  ).map(review => [review.sourceHash, review.authorizedChangeHash]))
  for (const change of Automerge.getChangesMetaSince(raw, [])) {
    const sourceHash = parseTransaction(change.message).sourceChangeHash
    if (parseTransaction(change.message).action === "reviewQuarantinedChange" && typeof sourceHash === "string" &&
      decisions.get(sourceHash) === "quarantined" && decisions.get(change.hash) === "admitted") {
      resolved.set(sourceHash, change.hash)
    }
  }
  return resolved
}

function parseTransaction(message?: string | null) {
  try { return message ? JSON.parse(message) as Record<string, unknown> : {} }
  catch { return {} }
}

export async function reviewCausalChange(changeHash: string, storage: WorkspaceStorage, callbacks: CausalReviewCallbacks): Promise<void> {
  const workspaceId = stateRuntime.activeDoc?.id
  const profile = stateRuntime.currentProfile
  if (!workspaceId || !profile) throw new Error("Workspace not hydrated")
  await storage.withWorkspaceTransaction(workspaceId, async transaction => {
    const evidence = await transaction.loadCausalEvidence()
    if (!evidence) throw new Error("No quarantined workspace history is available")
    const decision = evidence.decisions.find(item => item.hash === changeHash)
    if (decision?.status.type !== "quarantined") throw new Error("Only quarantined changes can be reviewed")
    const raw = Automerge.load<WorkspaceDocumentV2>(evidence.bytes)
    const borrowed = stateRuntime.activeDoc?.id === workspaceId ? stateRuntime.activeDoc : null
    let base: Automerge.Doc<WorkspaceDocumentV2> | undefined
    let createdDocument: Automerge.Doc<WorkspaceDocumentV2> | undefined
    let next: Automerge.Doc<WorkspaceDocumentV2> | undefined
    let transferred: Automerge.Doc<WorkspaceDocumentV2> | undefined
    try {
      if (resolvedReviewLinks(evidence, raw).has(changeHash)) throw new Error("This review already has an authorized change")
      const change = Automerge.getChangesMetaSince(raw, []).find(item => item.hash === changeHash)
      if (!change) throw new Error("Quarantined change bytes are unavailable")
      const before = Automerge.view(raw, change.deps)
      const candidate = Automerge.view(raw, [changeHash])
      const patch = reviewedPatch(before, candidate)
      const latest = await callbacks.latestWorkspaceDocument(workspaceId, storage, transaction)
      base = latest
      const role = await workspaceRole(latest, profile)
      ensureContentWrite(role)
      const authorityGrantHash = await localChangeAuthorityGrantHash(workspaceId, profile.identity.personId)
      const { localCommandSigningContext } = await import("./sync/localCommandSigning")
      const signingContext = await localCommandSigningContext(latest, profile, async () => { ensureContentWrite(await workspaceRole(latest, profile)) })
      const result = await executeReviewedWorkspaceChange(latest, changeHash, patch, profile, authorityGrantHash, signingContext)
      if (!result.ok) throw new Error(`Review failed: [${result.error.code}] ${result.error.message}`)
      createdDocument = result.value.newDoc
      assertWorkspaceTransition(role, latest, result.value.newDoc)
      const persisted = await callbacks.persistNewLocalChange(latest, result.value, profile, storage, changeHash, undefined, transaction)
      next = persisted
      if (stateRuntime.activeDoc?.id === workspaceId) {
        transferred = persisted
        callbacks.updateReactiveState(persisted)
      }
      await refreshCausalReview(storage, workspaceId)
      stateRuntime.storageChannel?.postMessage({ type: "workspace-persisted", workspaceId })
      callbacks.notifyLocalChanges(workspaceId)
    } finally {
      Automerge.free(raw)
      // The callback above has two exact ownership outcomes documented on its
      // contract: shared object or separately loaded projection. Deduplicate
      // only those callback-owned roots; never infer sharing from equal heads.
      for (const doc of new Set([base, createdDocument, next])) {
        if (doc && doc !== borrowed && doc !== transferred) Automerge.free(doc)
      }
    }
  })
}

type ReviewPatch = Parameters<typeof executeReviewedWorkspaceChange>[2]

function reviewedPatch(before: Automerge.Doc<WorkspaceDocumentV2>, candidate: Automerge.Doc<WorkspaceDocumentV2>): ReviewPatch & { preview: string[] } {
  const root = reviewRootFields(before, candidate)
  const entityIds = [...new Set([...Object.keys(before.entities), ...Object.keys(candidate.entities)])].sort()
  const entities: ReviewPatch["entities"] = []
  for (const id of entityIds) entities.push(...reviewEntity(before, candidate, id, root.preview))
  return { root: root.values as Parameters<typeof executeReviewedWorkspaceChange>[2]["root"], entities, preview: root.preview }
}

function reviewRootFields(before: Automerge.Doc<WorkspaceDocumentV2>, candidate: Automerge.Doc<WorkspaceDocumentV2>) {
  const values: Record<string, unknown> = {}
  const preview: string[] = []
  const keys = ["title", "archivedAt", "migration", "leads", "documents", "templates", "artifacts"] as const
  for (const key of keys) {
    const oldHas = Object.prototype.hasOwnProperty.call(before, key)
    const nextHas = Object.prototype.hasOwnProperty.call(candidate, key)
    if (!fieldChanged(oldHas, nextHas, before[key], candidate[key])) continue
    values[key] = nextHas ? cloneJson(candidate[key]) : undefined
    preview.push(`${key}: ${formatReviewValue(oldHas ? before[key] : undefined)} → ${formatReviewValue(nextHas ? candidate[key] : undefined)}`)
  }
  return { values, preview }
}

function reviewEntity(before: Automerge.Doc<WorkspaceDocumentV2>, candidate: Automerge.Doc<WorkspaceDocumentV2>, id: string,
  preview: string[]): ReviewPatch["entities"] {
  const oldHas = Object.prototype.hasOwnProperty.call(before.entities, id)
  const nextHas = Object.prototype.hasOwnProperty.call(candidate.entities, id)
  if (!fieldChanged(oldHas, nextHas, before.entities[id], candidate.entities[id])) return []
  if (!oldHas || !nextHas) {
    preview.push(`Entity ${id}: ${oldHas ? "present" : "absent"} → ${nextHas ? formatReviewValue(candidate.entities[id]) : "removed"}`)
    return [{ id, value: nextHas ? candidate.entities[id]! : null }]
  }
  return [reviewEntityFields(before.entities[id]!, candidate.entities[id]!, id, preview)]
}

function reviewEntityFields(before: WorkspaceEntity, candidate: WorkspaceEntity, id: string, preview: string[]) {
  const oldFields = before as unknown as Record<string, unknown>
  const nextFields = candidate as unknown as Record<string, unknown>
  const changes: Record<string, unknown> = {}
  const removedKeys: string[] = []
  for (const key of new Set([...Object.keys(oldFields), ...Object.keys(nextFields)])) {
    const oldHas = Object.prototype.hasOwnProperty.call(oldFields, key)
    const nextHas = Object.prototype.hasOwnProperty.call(nextFields, key)
    if (!fieldChanged(oldHas, nextHas, oldFields[key], nextFields[key])) continue
    if (nextHas) changes[key] = cloneJson(nextFields[key])
    else removedKeys.push(key)
    preview.push(`${String(nextFields.title ?? oldFields.title ?? id)} · ${key}: ${formatReviewValue(oldFields[key])} → ${formatReviewValue(nextFields[key])}`)
  }
  return { id, changes, removedKeys }
}

function fieldChanged(oldHas: boolean, nextHas: boolean, oldValue: unknown, nextValue: unknown): boolean {
  return oldHas !== nextHas || (oldHas && canonicalizeJson(oldValue) !== canonicalizeJson(nextValue))
}

function cloneJson<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

function formatReviewValue(value: unknown): string {
  if (value === undefined) return "empty"
  if (typeof value === "string") return `“${value.length > 160 ? `${value.slice(0, 157)}…` : value}”`
  const rendered = JSON.stringify(value)
  return rendered.length > 160 ? `${rendered.slice(0, 157)}…` : rendered
}

function ensureContentWrite(role: WorkspaceRole): void {
  if (role === "visitor") assertWorkspaceCapability(role, "content.write")
}
