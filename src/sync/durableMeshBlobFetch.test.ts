import { Buffer } from "node:buffer"
import * as meshBlob from "@meta-uber/mesh-blob"
import { afterEach, expect, it, vi } from "vitest"
import type { LocalProfile } from "../domain/identity"
import type { SessionEntry } from "./durableMeshBase"
import { fetchBlobFromCurrentSessions } from "./durableMeshBlobFetch"

// Deadline policy is exercised independently of real IndexedDB and signing tasks.
// DurableMesh integration tests retain real certificate and revocation coverage.
vi.mock("./blobRequestSigning", () => ({ blobRequestSigning: vi.fn(async () => ({
  personId: "person", deviceId: "device",
  sign: async () => { throw new Error("Timing fixture does not sign chunk payloads") },
})) }))

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function session(connectionId: string): SessionEntry {
  return { connectionId, workspaceId: "workspace", deviceId: "peer-device", instanceId: "instance", endpoint: "",
    remoteIssuedAt: "2026-10-15T00:00:00Z", direction: "incoming", connection: {} as never,
    session: {} as never, remotePersonId: "peer", blobTransferSupported: true, evict: async () => {} }
}

it("Given a late replacement and a four-chunk attachment, when each chunk makes bounded progress, then finish within the size-aware attempt budget", async () => {
  const descriptor: meshBlob.BlobDescriptor = { kind: "blob", version: 1, blobId: `sha256:${"A".repeat(43)}`,
    name: "private.bin", mediaType: "application/octet-stream", size: 960_000 }
  const bytes = new Uint8Array(descriptor.size)
  const authority = { profile: {} as LocalProfile, identity: "identity", credential: "credential", transportSecret: "secret" }
  const original = session("old"), replacement = session("new")
  let currentSession = original
  const blob = { read: vi.fn(async () => undefined),
    write: vi.fn(async (_descriptor: meshBlob.BlobDescriptor, _bytes: Uint8Array) => {}) }
  let requestCount = 0
  const request = vi.spyOn(meshBlob, "requestBlob").mockImplementation((_connection, _secret, _profile, _scope,
    _descriptor, options) => {
    requestCount += 1
    if (requestCount === 1) return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true })
    })
    return (async () => {
      for (let chunk = 0; chunk < 4; chunk += 1) {
        await new Promise(resolve => setTimeout(resolve, 3_000))
        await options?.ensureCurrent?.()
      }
      return bytes
    })()
  })
  vi.useFakeTimers()
  const pending = fetchBlobFromCurrentSessions({ workspaceId: "workspace", descriptor, blob,
    readAuthority: async () => authority, sessions: () => [currentSession],
    isCurrent: entry => entry === currentSession, currentRunId: () => 1, isRunning: () => true })
  // Observe rejections immediately; the final assertion still reports their original cause.
  const outcome = pending.then(value => ({ value }), error => ({ error }))
  await vi.advanceTimersByTimeAsync(0)
  expect(request).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(9_000)
  currentSession = replacement
  await vi.advanceTimersByTimeAsync(250)
  expect(request).toHaveBeenCalledTimes(2)
  expect(request.mock.calls[1]?.[0]).toBe(replacement.connection)
  const deadline = request.mock.calls[1]?.[5]?.deadlineAt
  if (typeof deadline !== "number") throw new Error("Replacement attempt did not receive a deadline")
  expect(deadline - Date.now()).toBe(16_000)
  await vi.advanceTimersByTimeAsync(12_000)
  const result = await outcome
  if ("error" in result) throw result.error
  if (!result.value) throw new Error("Transfer returned no verified bytes")
  expect(Buffer.from(result.value).equals(Buffer.from(bytes))).toBe(true)
  expect(blob.write).toHaveBeenCalledOnce()
  const [cachedDescriptor, cachedBytes] = blob.write.mock.calls[0]!
  expect(cachedDescriptor).toEqual(descriptor)
  expect(Buffer.from(cachedBytes).equals(Buffer.from(bytes))).toBe(true)
})
