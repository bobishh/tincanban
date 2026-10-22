import * as Automerge from "@automerge/automerge/slim"
import type { WorkspaceWriteAuthorityEvidence } from "./workspaceAdmission"
import type { WorkspaceDocumentV2 } from "../domain/model"

function missingRecordHeads(value: unknown, document: Automerge.Doc<WorkspaceDocumentV2>): string[] {
  const entry = value as { record?: unknown; payload?: unknown }
  const record = (entry?.record ?? entry) as { payload?: { workspaceHeads?: unknown; deviceId?: unknown } }
  const payload = record?.payload
  if (!Array.isArray(payload?.workspaceHeads)) return []
  const device = typeof payload.deviceId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(payload.deviceId)
    ? ` device=${payload.deviceId}` : ""
  return payload.workspaceHeads.filter((head): head is string =>
    typeof head === "string" && /^[0-9a-f]{64}$/.test(head) && !Automerge.hasHeads(document, [head]))
    .slice(0, 3).map(head => `${device} missingHead=${head}`)
}

/** Bounded public evidence identifiers only. Diagnosis never changes admission. */
export function explainWorkspaceBoundaryFailure(error: unknown, document: Automerge.Doc<WorkspaceDocumentV2>,
  authority: WorkspaceWriteAuthorityEvidence): unknown {
  if (!(error instanceof Error) || !error.message.includes("Workspace ownership boundary is missing from the document")) return error
  const groups: Array<[string, unknown[]]> = [["ownership-transfer", authority.ownershipTransfers],
    ["succession", authority.successionClaims], ["person-revocation", authority.revocations],
    ["device-revocation", authority.deviceRevocations], ["departure", authority.departures]]
  const missing: string[] = []
  for (const [kind, entries] of groups) for (const value of entries) {
    if (missing.length >= 3) break
    missing.push(...missingRecordHeads(value, document).slice(0, 3 - missing.length).map(detail => `${kind}${detail}`))
  }
  return missing.length ? new Error(`${error.message}; ${missing.join("; ")}`, { cause: error }) : error
}
