import { canonicalizeJson } from "../domain/identity"
import type { PrivateReplicaConflictCapture } from "./privateReplicaRepository"
import { parseState, retiredReplicaStateKeys, scopeKey, stateKey } from "./privateReplicaRepositoryState"

function authoritativeSourceCondition(capture: PrivateReplicaConflictCapture) {
  const key = stateKey(capture.sourceWire.personId), retired = new Set(retiredReplicaStateKeys(capture.sourceWire.personId))
  const seen = new Set<string>()
  for (const condition of capture.sourceConditions) {
    if (seen.has(condition.key) || (condition.key !== key && !retired.has(condition.key))) {
      throw new Error("Invalid credential recovery source dependency")
    }
    seen.add(condition.key)
  }
  const condition = capture.sourceConditions.find(condition => condition.key === key)
  if (!condition || typeof condition.value !== "string") throw new Error("Authoritative credential recovery source condition is missing")
  return { key: condition.key, value: condition.value }
}

function sourceEvidence(capture: PrivateReplicaConflictCapture) {
  const { sourceConditions, ...evidence } = capture
  void sourceConditions
  const owner = capture.sourceWire.personId, origin = capture.previousVariants[0]?.origin
  if (!origin) throw new Error("Credential conflict source origin is missing")
  const condition = authoritativeSourceCondition(capture), state = parseState(condition.value, owner)
  const frozenScopes = new Set(state.entries.filter(entry => entry.origin === origin).map(scopeKey))
  // Other origins keep replicating while this origin's credentials are frozen.
  const progress = Object.fromEntries(Object.entries(state.progress).filter(([key]) => frozenScopes.has(key)))
  // Old journals retain obsolete dependency names; only the authoritative record remains a live dependency.
  return { ...evidence, sourceConditions: [{ key: condition.key, value: canonicalizeJson({ ...state, progress }) }] }
}

function repositoryDifference(left: PrivateReplicaConflictCapture, right: PrivateReplicaConflictCapture): string {
  const leftState = left.sourceConditions.find(condition => condition.key === stateKey(left.sourceWire.personId))
  const rightState = right.sourceConditions.find(condition => condition.key === stateKey(right.sourceWire.personId))
  if (!leftState?.value || !rightState?.value) return "repositoryState"
  const a = parseState(leftState.value, left.sourceWire.personId), b = parseState(rightState.value, right.sourceWire.personId)
  for (const part of ["actorId", "writerUpgrades"] as const) {
    if (canonicalizeJson({ value: a[part] }) !== canonicalizeJson({ value: b[part] })) return `repositoryState.${part}`
  }
  return "repositoryState"
}

/** Compare frozen evidence, not unrelated progress; activation still CASes the latest complete record. */
export function privateReplicaConflictSourceDifference(left: PrivateReplicaConflictCapture,
  right: PrivateReplicaConflictCapture): string | undefined {
  const leftEvidence = sourceEvidence(left), rightEvidence = sourceEvidence(right)
  if (canonicalizeJson(leftEvidence) === canonicalizeJson(rightEvidence)) return undefined
  const categories = [
    ["sourceWire", "sourceWire"], ["sourceRevision", "sourceRevision"], ["previousVariants", "previousVariants"],
    ["progress", "progress"], ["progressConfig", "progressConfig"], ["progressRecord", "progressRecord"],
    ["sourceConditions", "repositoryState"],
  ] as const
  for (const [field, label] of categories) {
    const hasLeft = Object.hasOwn(leftEvidence, field), hasRight = Object.hasOwn(rightEvidence, field)
    if (hasLeft !== hasRight || canonicalizeJson({ value: leftEvidence[field] }) !== canonicalizeJson({ value: rightEvidence[field] })) {
      if (field === "sourceConditions") return repositoryDifference(left, right)
      return label
    }
  }
  return "captureShape"
}

export function samePrivateReplicaConflictSource(left: PrivateReplicaConflictCapture, right: PrivateReplicaConflictCapture): boolean {
  return privateReplicaConflictSourceDifference(left, right) === undefined
}
