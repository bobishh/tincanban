import { canonicalizeJson } from "./domain/identity"
import * as Automerge from "@automerge/automerge/slim"
import type { StoredCausalEvidence, StoredChange } from "./storageJournal"
import type { WorkspaceDocumentV2 } from "./domain/model"

/** Classified raw changes must not reappear through the legacy local journal. */
export function replayAdmittedJournal(doc: Automerge.Doc<WorkspaceDocumentV2>, changes: StoredChange[], evidence?: StoredCausalEvidence) {
  const excluded = new Set(evidence?.decisions.filter(decision => decision.status.type !== "admitted").map(decision => decision.hash))
  const missing = changes.filter(change => !excluded.has(change.changeHash) && !Automerge.hasHeads(doc, [change.changeHash]))
  if (!missing.length) return doc
  try { return Automerge.applyChanges(doc, missing.map(change => change.bytes))[0] }
  catch {
    // Preserve legacy recovery of independent changes when one dependency is unavailable.
    for (const change of missing) {
      try { [doc] = Automerge.applyChanges(doc, [change.bytes]) } catch { /* Dependent change remains in raw recovery history. */ }
    }
    return doc
  }
}

/** Legacy writes extend raw recovery history, never its prior admission checkpoint. */
export function extendRawEvidence(evidence: StoredCausalEvidence, changes: StoredChange[]): StoredCausalEvidence {
  if (!changes.length) return evidence
  // A full local admission classified every raw hash; only an unknown journal hash needs assembly.
  if (evidence.admissionCheckpoint && !evidence.admissionCheckpoint.incremental) {
    const classified = new Set(evidence.decisions.map(decision => decision.hash))
    if (changes.every(change => classified.has(change.changeHash))) return evidence
  }
  let raw = Automerge.load(evidence.bytes)
  try {
    const missing = changes.filter(change => !Automerge.hasHeads(raw, [change.changeHash]))
    if (!missing.length) return evidence
    ;[raw] = Automerge.applyChanges(raw, missing.map(change => change.bytes))
    return { ...evidence, bytes: Automerge.save(raw), admissionCheckpoint: undefined }
  } finally { Automerge.free(raw) }
}

/** Copy persisted evidence bytes while keeping immutable classification records. */
export function cloneCausalEvidence(evidence: StoredCausalEvidence | null | undefined): StoredCausalEvidence | null {
  return evidence ? {
    bytes: new Uint8Array(evidence.bytes),
    decisions: evidence.decisions,
    authorizationEvidence: evidence.authorizationEvidence,
    admissionCheckpoint: evidence.admissionCheckpoint ? structuredClone(evidence.admissionCheckpoint) : undefined,
    dismissedHashes: evidence.dismissedHashes ? [...evidence.dismissedHashes] : undefined,
    resolvedReviews: evidence.resolvedReviews?.map(review => ({ ...review })),
  } : null
}

/** Keep the prior evidence when a snapshot commit does not reclassify history. */
export function snapshotCausalEvidence(
  incoming: StoredCausalEvidence | undefined,
  previous: StoredCausalEvidence | undefined,
): StoredCausalEvidence | undefined {
  if (!incoming) return previous
  const dismissedHashes = incoming.dismissedHashes ?? (previous?.dismissedHashes ?? []).filter(hash =>
    incoming.decisions.some(decision => decision.hash === hash && decision.status.type !== "admitted"))
  const resolvedReviews = incoming.resolvedReviews ?? (previous?.resolvedReviews ?? []).filter(review =>
    incoming.decisions.some(decision => decision.hash === review.sourceHash && decision.status.type !== "admitted"))
  return cloneCausalEvidence({ ...incoming, dismissedHashes, resolvedReviews }) ?? undefined
}

/** Compare shared evidence; local admission bookkeeping is not a replicated change. */
export function causalEvidenceChanged(
  previous: StoredCausalEvidence | undefined,
  current: StoredCausalEvidence | undefined,
): boolean {
  if (!current) return false
  if (!previous) return true
  return !sameBytes(previous.bytes, current.bytes) ||
    canonicalizeJson(previous.decisions) !== canonicalizeJson(current.decisions) ||
    canonicalizeJson(previous.authorizationEvidence ?? []) !== canonicalizeJson(current.authorizationEvidence ?? []) ||
    canonicalizeJson(previous.dismissedHashes ?? []) !== canonicalizeJson(current.dismissedHashes ?? []) ||
    canonicalizeJson(previous.resolvedReviews ?? []) !== canonicalizeJson(current.resolvedReviews ?? [])
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
