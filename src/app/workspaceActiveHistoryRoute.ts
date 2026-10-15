type HistoryRouteCandidate<T> = { baselineId: string; signedJson: Uint8Array; route: T }
type ActiveHistoryBasis = { baselineId?: string; signedJson: Uint8Array }

/** Routing starts at the snapshot's active basis. Native still verifies that basis and each signed parent edge. */
export function selectActiveHistoryRoute<T>(routes: HistoryRouteCandidate<T>[], active: ActiveHistoryBasis | undefined): T | undefined {
  if (!active) return undefined
  const candidates = routes.filter(route => route.baselineId === active.baselineId)
  if (!active.baselineId || candidates.length === 0) throw new Error("The active history basis is unavailable; recover its complete private backup")
  for (const candidate of candidates) {
    if (candidate.signedJson.length !== active.signedJson.length ||
        candidate.signedJson.some((byte, index) => byte !== active.signedJson[index])) {
      throw new Error("Active history sources disagree on their signed descriptor")
    }
  }
  return candidates[0]!.route
}
