import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { HistoryAncestorBudget } from "./historyAncestorBudget"
import { captureReceivedHistoryCandidate, type ReceivedHistoryCandidate } from "./receivedHistoryCandidate"

type AncestorEvidence = { head: ReceivedHistoryCandidate; ancestors: ReceivedHistoryCandidate[] }
declare const verifiedAncestors: unique symbol
export type VerifiedHistoryAncestors = { readonly [verifiedAncestors]: true }
const evidence = new WeakMap<VerifiedHistoryAncestors, AncestorEvidence>()
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index])
function parentId(basis: WasmVerifiedReceivedHistoryBaseline): unknown {
  return (basis.envelope() as { payload: { previousBaselineId?: unknown } }).payload.previousBaselineId
}

/** Ephemeral Native-checked source evidence, never a persisted host trust flag. */
export function captureVerifiedHistoryAncestors(head: WasmVerifiedReceivedHistoryBaseline,
  parents: WasmVerifiedReceivedHistoryBaseline[]): VerifiedHistoryAncestors {
  const captured = captureReceivedHistoryCandidate(head)
  if (parents.length > 256) throw new Error("Verified history ancestry exceeds its bound")
  const ancestors: ReceivedHistoryCandidate[] = [], visited = new Set([captured.baselineId])
  let child = head
  const budget = new HistoryAncestorBudget()
  budget.addBasis(head)
  for (const parent of parents) {
    child.verifyPreviousBaseline(parent)
    const row = captureReceivedHistoryCandidate(parent)
    if (row.workspaceId !== captured.workspaceId || visited.has(row.baselineId)) throw new Error("Verified history ancestry is cyclic or crosses workspaces")
    visited.add(row.baselineId)
    budget.addBasis(parent)
    ancestors.push(row); child = parent
  }
  if (parentId(child) !== undefined && parentId(child) !== null) throw new Error("Verified history ancestry is incomplete")
  const token = {} as VerifiedHistoryAncestors
  evidence.set(token, { head: captured, ancestors })
  return token
}

export function readVerifiedHistoryAncestors(token: VerifiedHistoryAncestors | undefined,
  candidate: WasmVerifiedReceivedHistoryBaseline): ReceivedHistoryCandidate[] {
  if (!token) return []
  const stored = evidence.get(token)
  if (!stored) throw new Error("History ancestry is not Native-verified")
  if (!equal(stored.head.signedJson, candidate.originalJson()) || !equal(stored.head.document, candidate.document())) {
    throw new Error("Verified history ancestry belongs to another current head")
  }
  return structuredClone(stored.ancestors)
}
