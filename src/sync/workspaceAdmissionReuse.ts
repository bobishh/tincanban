import type { WorkspaceAdmissionResult } from "../product-replica"

// Keep only the latest exact packet result in memory. Durable projection reuse
// uses the separate atomic admission checkpoint, never this network-input cache.
const recent = new Map<string, { key: string; result: WorkspaceAdmissionResult; rawBytes: Uint8Array; documentBytes: number }>()
const maxWorkspaces = 8
const maxDocumentBytes = 16 * 1024 * 1024

export function reusedWorkspaceAdmission(workspaceId: string, key: string): { result: WorkspaceAdmissionResult; rawBytes: Uint8Array } | undefined {
  const entry = recent.get(workspaceId)
  if (entry?.key !== key) return
  return { result: structuredClone(entry.result), rawBytes: entry.rawBytes.slice() }
}

export function rememberWorkspaceAdmission(workspaceId: string, key: string, result: WorkspaceAdmissionResult, rawBytes: Uint8Array): void {
  recent.delete(workspaceId)
  const documentBytes = rawBytes.byteLength + result.authorizedDocument.byteLength
  if (documentBytes > maxDocumentBytes) return
  let retainedBytes = [...recent.values()].reduce((sum, entry) => sum + entry.documentBytes, 0)
  for (const [oldest, entry] of recent) {
    if (recent.size < maxWorkspaces && retainedBytes + documentBytes <= maxDocumentBytes) break
    recent.delete(oldest)
    retainedBytes -= entry.documentBytes
  }
  recent.set(workspaceId, { key, result: structuredClone(result), rawBytes: rawBytes.slice(), documentBytes })
}
