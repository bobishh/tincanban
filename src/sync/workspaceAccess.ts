import * as Automerge from "@automerge/automerge/slim"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { canonicalAuthorityJson } from "./authorityFingerprint"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { WorkspaceRole } from "../domain/permissions"
import { diagnoseStartupStep } from "./startupDiagnostics"
import { telemetryConfig } from "./telemetryConfig"
import type { WorkspaceAccessInput } from "./workspaceAccessInput"
export type { AccessWorkerRequest } from "./workspaceAccessInput"

type Entry = { evidence: string; result: Promise<WorkspaceRole>; expires: number; checkedAt: number; verified: boolean }
const cache = new Map<string, Entry>()

function documentKey(doc: Automerge.Doc<WorkspaceDocumentV2>) {
  return `${doc.id}:${Automerge.getHeads(doc).sort().join()}`
}

export function inheritLocalMoveAccess(before: Automerge.Doc<WorkspaceDocumentV2>, after: Automerge.Doc<WorkspaceDocumentV2>) {
  const entry = cache.get(documentKey(before))
  if (entry?.verified && before.id === after.id && before.ownerPersonId === after.ownerPersonId) {
    cache.set(documentKey(after), entry)
    trimCache()
  }
}

export function decideAccess(doc: Automerge.Doc<WorkspaceDocumentV2>, evidence: { snapshot: Record<string, unknown> } & Record<string, unknown>): Promise<WorkspaceRole> {
  const key = documentKey(doc)
  const signature = canonicalAuthorityJson(evidence)
  const now = Date.now()
  const previous = cache.get(key)
  if (previous?.evidence === signature && previous.checkedAt <= now && previous.expires > now) return previous.result
  const frozen = structuredClone(evidence)
  const deadline = automationDeadline(frozen)
  const detail = { workspaceId: doc.id, bytes: 0 }
  const result = (async () => {
    const input = await diagnoseStartupStep("access-serialize", () => {
      const document = Automerge.save(doc)
      detail.bytes = document.byteLength
      return { ...frozen, snapshot: { ...frozen.snapshot, document } }
    }, detail)
    const role = await diagnoseStartupStep("access-policy", () => typeof window === "undefined"
      ? meshRustRuntime().state.decideWorkspaceAccess({ ...input,
        snapshot: { ...input.snapshot, document: Array.from(input.snapshot.document) } }, Date.now()) : offThread(input), detail)
    return role === "automation" && deadline <= Date.now() ? "visitor" : role
  })()
  const entry: Entry = { evidence: signature, result, expires: deadline > now ? deadline : Infinity, checkedAt: now, verified: false }
  cache.set(key, entry)
  void result.then(role => {
    entry.verified = true
    entry.checkedAt = Date.now()
    if (role !== "automation") entry.expires = Infinity
  }, () => { if (cache.get(key) === entry) cache.delete(key) })
  trimCache()
  return result
}

/** Successfully checked authority timestamps remain valid as time advances; automation alone expires. */
function automationDeadline(evidence: Record<string, unknown>) {
  const expires = (evidence.grant as { payload?: { automation?: { expiresAt?: unknown } } } | undefined)?.payload?.automation?.expiresAt
  return typeof expires === "number" ? expires : Infinity
}

function trimCache() { if (cache.size > 100) cache.delete(cache.keys().next().value!) }

async function offThread(input: WorkspaceAccessInput): Promise<WorkspaceRole> {
  const { runWorkspaceAccess } = await import("./workspaceAdmissionClient")
  return runWorkspaceAccess(input, telemetryConfig().enabled)
}
