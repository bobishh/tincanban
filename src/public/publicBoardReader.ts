export class PublicBoardRequestTimeoutError extends Error {}

export async function readWithTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, controller = new AbortController(), timeoutMs = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => {
        controller.abort()
        reject(new PublicBoardRequestTimeoutError("Public board request timed out"))
      }, timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export type PublicSnapshotIdentity = { boardId: string; revision: number }
export type PublicSnapshotDecision = "replace" | "unchanged" | "rollback" | "different-board"

export function publicSnapshotDecision(current: PublicSnapshotIdentity | null, next: PublicSnapshotIdentity): PublicSnapshotDecision {
  if (!current || current.boardId !== next.boardId) return current ? "different-board" : "replace"
  if (next.revision < current.revision) return "rollback"
  if (next.revision === current.revision) return "unchanged"
  return "replace"
}
