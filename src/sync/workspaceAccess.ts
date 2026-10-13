import * as Automerge from "@automerge/automerge/slim"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import { canonicalAuthorityJson } from "./authorityFingerprint"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { WorkspaceRole } from "../domain/permissions"
import { diagnoseStartupStep } from "./startupDiagnostics"
import { telemetryConfig } from "./telemetryConfig"
import type { WorkspaceAccessInput } from "./workspaceAccessInput"
export type { AccessWorkerRequest } from "./workspaceAccessInput"

type Entry = { evidence: string; result: Promise<WorkspaceRole>; expires: number }
const cache = new Map<string, Entry>()

function documentKey(doc: Automerge.Doc<WorkspaceDocumentV2>) {
  return `${doc.id}:${Automerge.getHeads(doc).sort().join()}`
}

export function inheritLocalMoveAccess(before: Automerge.Doc<WorkspaceDocumentV2>, after: Automerge.Doc<WorkspaceDocumentV2>) {
  const entry = cache.get(documentKey(before))
  if (entry && before.ownerPersonId === after.ownerPersonId) {
    cache.set(documentKey(after), { ...entry })
    trimCache()
  }
}

export function decideAccess(doc: Automerge.Doc<WorkspaceDocumentV2>, evidence: { snapshot: Record<string, unknown> } & Record<string, unknown>): Promise<WorkspaceRole> {
  const key = documentKey(doc)
  const signature = canonicalAuthorityJson(evidence)
  const previous = cache.get(key)
  if (previous?.evidence === signature && previous.expires > Date.now()) return previous.result
  const detail = { workspaceId: doc.id, bytes: 0 }
  const result = (async () => {
    const input = await diagnoseStartupStep("access-serialize", () => {
      const document = Automerge.save(doc)
      detail.bytes = document.byteLength
      return { ...evidence, snapshot: { ...evidence.snapshot, document } }
    }, detail)
    return diagnoseStartupStep("access-policy", () => typeof window === "undefined"
      ? meshRustRuntime().state.decideWorkspaceAccess({ ...input,
        snapshot: { ...input.snapshot, document: Array.from(input.snapshot.document) } }, Date.now()) : offThread(input), detail)
  })()
  const entry = { evidence: signature, result, expires: Date.now() + 60_000 }
  cache.set(key, entry)
  void result.catch(() => { if (cache.get(key) === entry) cache.delete(key) })
  trimCache()
  return result
}

function trimCache() { if (cache.size > 100) cache.delete(cache.keys().next().value!) }

async function offThread(input: WorkspaceAccessInput): Promise<WorkspaceRole> {
  const { runWorkspaceAccess } = await import("./workspaceAdmissionClient")
  return runWorkspaceAccess(input, telemetryConfig().enabled)
}
