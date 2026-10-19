import type { WorkspaceAdmissionResult } from "../product-replica"

/** Reuse the caller's Automerge handle only when admission kept its exact heads. */
export function canReuseAdmittedDocument(admission: WorkspaceAdmissionResult, candidateHeads: string[]): boolean {
  const needed = [...admission.neededHashes].sort()
  const decided = admission.decisions.map(decision => decision.hash).sort()
  const admitted = [...admission.admittedHashes].sort()
  if (admission.decisions.length !== needed.length ||
    admission.decisions.some(decision => decision.status.type !== "admitted") ||
    !sameList(needed, decided) || !sameList(needed, admitted)) return false
  return sameList([...admission.authorizedHeads].sort(), [...candidateHeads].sort())
}

function sameList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
