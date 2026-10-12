import { canonicalizeJson } from "./domain/identity"
import type { StoredCausalEvidence } from "./storageJournal"

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
