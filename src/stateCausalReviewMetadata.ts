import type { StoredCausalEvidence } from "./storageJournal"

export function causalReviewMetadata(
  previous: StoredCausalEvidence | null,
  sourceHash: string | undefined,
  authorizedChangeHash: string,
) {
  const resolved = new Map((previous?.resolvedReviews ?? []).map(review => [review.sourceHash, review.authorizedChangeHash]))
  const dismissed = new Set(previous?.dismissedHashes ?? [])
  if (sourceHash) { resolved.set(sourceHash, authorizedChangeHash); dismissed.add(sourceHash) }
  return {
    dismissedHashes: [...dismissed].sort(),
    resolvedReviews: [...resolved].map(([reviewSourceHash, authorizedHash]) => ({
      sourceHash: reviewSourceHash, authorizedChangeHash: authorizedHash,
    })),
  }
}

export function hasUnresolvedCausalChanges(evidence: StoredCausalEvidence | null): boolean {
  return evidence?.decisions.some(decision => decision.status.type !== "admitted") ?? false;
}
