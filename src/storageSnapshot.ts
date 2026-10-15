import type { Heads } from "./domain/model"
import { fromBase64Url } from "./domain/identity"
import type { StoredWorkspaceSnapshot, StoredCausalEvidence } from "./storageJournal"

export type StoredSnapshot = {
  workspaceId: string
  heads: Heads
  bytes: Uint8Array
  causalEvidence?: StoredCausalEvidence
  receivedHistory?: StoredWorkspaceSnapshot["receivedHistory"]
  savedAt: string
}

export function parseStoredSnapshot(raw: string, workspaceId: string): StoredSnapshot | null {
  try {
    const parsed = JSON.parse(raw) as { bytesBase64?: string; heads?: Heads; savedAt?: string }
    return {
      workspaceId,
      heads: parsed.heads ?? [],
      bytes: parsed.bytesBase64 ? fromBase64Url(parsed.bytesBase64) : new Uint8Array(JSON.parse(raw) as number[]),
      savedAt: parsed.savedAt ?? new Date().toISOString(),
    }
  } catch {
    return null
  }
}
