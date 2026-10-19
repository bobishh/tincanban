import { canonicalizeJson } from "../domain/identity"
import type { PrivateReplicaConflictCapture } from "./privateReplicaRepository"
import { parseState, scopeKey, stateKey } from "./privateReplicaRepositoryState"

function sourceEvidence(capture: PrivateReplicaConflictCapture) {
  const { sourceConditions, ...evidence } = capture
  const owner = capture.sourceWire.personId, origin = capture.previousVariants[0]?.origin
  if (!origin) throw new Error("Credential conflict source origin is missing")
  return { ...evidence, sourceConditions: sourceConditions.map(condition => {
    if (condition.key !== stateKey(owner) || condition.value === null) return condition
    const state = parseState(condition.value, owner)
    const frozenScopes = new Set(state.entries.filter(entry => entry.origin === origin).map(scopeKey))
    // Other origins keep replicating while this origin's credentials are frozen.
    const progress = Object.fromEntries(Object.entries(state.progress).filter(([key]) => frozenScopes.has(key)))
    return { key: condition.key, value: canonicalizeJson({ ...state, progress }) }
  }) }
}

/** Compare frozen evidence, not unrelated progress; activation still CASes the latest complete record. */
export function samePrivateReplicaConflictSource(left: PrivateReplicaConflictCapture, right: PrivateReplicaConflictCapture): boolean {
  return canonicalizeJson(sourceEvidence(left)) === canonicalizeJson(sourceEvidence(right))
}
