import { canonicalizeJson } from "../domain/identity"
import type { ArchiveObjectReadBinding } from "@meta-uber/mesh-replication/history-archive"

export type PeerHistoryReadRequest = { objectId: string; maximumBytes: number; binding: ArchiveObjectReadBinding }
export type PeerHistoryReadResult = { failed: boolean; error?: unknown; bytes?: Uint8Array }
type Result = PeerHistoryReadResult & { maximumBytes: number }
// Bound history bursts so heartbeat/control reads can share SDK peer slots and queue.
const MAX_READS = 2, MAX_RESERVED_BYTES = 2 * 1024 * 1024

/** Bounded independent leaf reads; callers consume and retain results in canonical order. */
export class PeerHistoryReadAhead {
  private readonly results = new Map<string, Result>()
  private reservedBytes = 0
  constructor(private readonly read: (requests: PeerHistoryReadRequest[]) => Promise<PeerHistoryReadResult[]>) {}
  private key(request: PeerHistoryReadRequest) { return canonicalizeJson(request) }
  async batch(requests: PeerHistoryReadRequest[]) {
    const selected = new Map<string, PeerHistoryReadRequest>()
    for (const input of requests) {
      const request = structuredClone(input), key = this.key(request)
      if (!Number.isSafeInteger(request.maximumBytes) || request.maximumBytes < 0 || request.maximumBytes > 256 * 1024) {
        throw new Error("Invalid peer history prefetch bound")
      }
      if (selected.size === MAX_READS) break
      if (this.results.has(key) || selected.has(key) || this.reservedBytes + request.maximumBytes > MAX_RESERVED_BYTES) continue
      this.reservedBytes += request.maximumBytes
      selected.set(key, request)
    }
    // No request survives this await. Nested traversal cannot multiply inflight reads.
    if (!selected.size) return
    let results: PeerHistoryReadResult[]
    try { results = await this.read([...selected.values()]) }
    catch (error) { results = [...selected].map(() => ({ failed: true, error })) }
    let index = 0
    for (const [key, request] of selected) this.results.set(key, { ...results[index++]!, maximumBytes: request.maximumBytes })
  }
  take(request: PeerHistoryReadRequest): { found: boolean; bytes?: Uint8Array } {
    const key = this.key(request), result = this.results.get(key)
    if (!result) return { found: false }
    this.results.delete(key)
    this.reservedBytes -= result.maximumBytes
    if (result.failed) throw result.error
    return { found: true, bytes: result.bytes }
  }
}
