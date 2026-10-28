import type { PeerStore } from "./peerStore"
import type { WorkspaceMemberBundle } from "./meshRecords"
import { BLOB_CHUNK_BYTES, requestBlob, respondToBlobRequest, type BlobDescriptor, type RequestBlobOptions } from "@meta-uber/mesh-blob"
import type { LocalProfile } from "../domain/identity"
import type { SessionEntry } from "./durableMeshBase"
import { blobRequestSigning } from "./blobRequestSigning"
import { MeshNetworkError } from "@meta-uber/mesh-transport"

type BlobCache = {
  read(descriptor: BlobDescriptor): Promise<Uint8Array | undefined>
  write(descriptor: BlobDescriptor, bytes: Uint8Array): Promise<void>
}

/** Serve a signed request only while its captured session and live workspace authority remain current. */
export async function respondToCurrentBlobRequest(input: {
  workspaceId: string; deviceId: string; secret: string; store: Pick<PeerStore, "getPeer">;
  blob?: Pick<BlobCache, "read"> & { resolve(workspaceId: string, blobId: string): Promise<BlobDescriptor | undefined> }
  ensureCurrent(): Promise<void>
}, stream: Parameters<typeof respondToBlobRequest>[0], frame: Uint8Array): Promise<void> {
  try {
    await input.ensureCurrent()
    const blob = input.blob
    if (!blob) throw new Error("Blob storage is unavailable")
    const peer = await input.store.getPeer(input.workspaceId, input.deviceId)
    await input.ensureCurrent()
    const bundle = peer?.advertisement as WorkspaceMemberBundle | undefined
    if (!peer || !bundle?.publicKey || !Array.isArray(bundle.certificates)) throw new Error("Blob requester is unavailable")
    await respondToBlobRequest({
      send: async bytes => { await input.ensureCurrent(); await stream.send(bytes) },
      closeSend: () => stream.closeSend(),
    }, frame, {
      secret: input.secret, scopeId: input.workspaceId,
      identity: { personId: peer.personId, publicKey: bundle.publicKey,
        displayName: bundle.advertisement?.payload?.deviceName ?? "Peer" },
      certificates: bundle.certificates,
      descriptor: async blobId => {
        await input.ensureCurrent()
        const descriptor = await blob.resolve(input.workspaceId, blobId)
        await input.ensureCurrent()
        return descriptor
      },
      bytes: async descriptor => {
        await input.ensureCurrent()
        const bytes = await blob.read(descriptor)
        await input.ensureCurrent()
        return bytes
      },
    })
  } catch (error) { await stream.closeSend().catch(() => {}); throw error }
}

type BlobFetchInput = {
  workspaceId: string
  descriptor: BlobDescriptor
  blob: BlobCache
  readAuthority(): Promise<BlobAuthoritySnapshot>
  sessions(): SessionEntry[]
  isCurrent(entry: SessionEntry, runId: number): boolean
  currentRunId(): number
  isRunning(): boolean
}

type BlobAttemptResult = { kind: "success"; bytes: Uint8Array } | {
  kind: "failure"
  error: unknown
  sessionReplaced: boolean
  retryNetwork: boolean
}

const MAX_BLOB_RECOVERY_MS = 10_000
const MAX_BLOB_ATTEMPT_MS = 10_000
const MAX_BLOB_CHUNK_ALLOWANCE_MS = 2_000

class BlobFetchAuthorityChanged extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options) }
}

class BlobFetchSessionReplaced extends Error {
  constructor() { super("Mesh session changed during blob transfer") }
}

export type BlobAuthoritySnapshot = {
  profile: LocalProfile
  identity: string
  credential: string
  transportSecret: string
}

/** Fetch from a current peer session, and cache only bytes returned under unchanged local authority. */
export async function fetchBlobFromCurrentSessions(input: BlobFetchInput): Promise<Uint8Array | undefined> {
  const descriptor = structuredClone(input.descriptor)
  const runId = input.currentRunId()
  const local = await input.blob.read(descriptor)
  if (local) return local

  const recoveryDeadline = Date.now() + MAX_BLOB_RECOVERY_MS
  const attemptBudget = blobAttemptBudget(descriptor.size)
  const hardDeadline = recoveryDeadline + attemptBudget
  assertRuntime(input, runId)
  const originalAuthority = await input.readAuthority()
  let lastError: unknown
  while (Date.now() < hardDeadline) {
    // Retries may begin only during the bounded recovery window. A request already
    // started before this point may finish under its own bounded attempt deadline.
    if (Date.now() >= recoveryDeadline) break
    assertRuntime(input, runId)
    const before = await readUnchangedAuthority(input, originalAuthority)
    const sessions = input.sessions()
    if (sessions.length === 0) {
      await waitForNextSession()
      continue
    }

    let replaced = false
    let retryNetwork = false
    for (const entry of sessions) {
      if (Date.now() >= recoveryDeadline) break
      if (!input.isCurrent(entry, runId)) { replaced = true; continue }
      const attemptDeadline = Math.min(hardDeadline, Date.now() + attemptBudget)
      const result = await attemptBlobSession(input, entry, descriptor, before, originalAuthority, runId, attemptDeadline, hardDeadline)
      if (result.kind === "success") return result.bytes
      lastError = result.error
      replaced = replaced || result.sessionReplaced
      retryNetwork = retryNetwork || result.retryNetwork
    }
    if (replaced) continue
    if (retryNetwork) {
      // Stream failure can precede the session receive loop's eviction callback.
      await waitForNextSession()
      continue
    }
    break
  }

  if (lastError) throw lastError
  throw new Error("No connected peer can provide this file")
}

function blobAttemptBudget(size: number): number {
  // Keep one fixed setup allowance, then budget each remaining sequential SDK chunk.
  const chunkCount = Math.ceil(size / BLOB_CHUNK_BYTES)
  return MAX_BLOB_ATTEMPT_MS + Math.max(0, chunkCount - 1) * MAX_BLOB_CHUNK_ALLOWANCE_MS
}

async function attemptBlobSession(input: BlobFetchInput, entry: SessionEntry, descriptor: BlobDescriptor,
  profileAndSecret: BlobAuthoritySnapshot, originalAuthority: BlobAuthoritySnapshot, runId: number,
  attemptDeadline: number, hardDeadline: number): Promise<BlobAttemptResult> {
  const controller = new AbortController()
  const stopMonitor = monitorBlobAttempt(input, entry, runId, originalAuthority, controller)
  try {
    const ensureCurrent = async () => {
      if (controller.signal.aborted) throw controller.signal.reason
      if (Date.now() >= attemptDeadline || Date.now() >= hardDeadline) throw new Error("Blob transfer deadline exceeded")
      assertRuntime(input, runId)
      await readUnchangedAuthority(input, originalAuthority)
      if (!input.isCurrent(entry, runId)) throw new BlobFetchSessionReplaced()
    }
    const signing = await blobRequestSigning(profileAndSecret.profile, input.workspaceId, descriptor.blobId, async () => {
      await ensureCurrent()
      return JSON.stringify([originalAuthority.identity, originalAuthority.credential, runId, entry.connectionId])
    })
    const bytes = await requestBlob(retryableBlobConnection(entry.connection), profileAndSecret.transportSecret, profileAndSecret.profile,
      input.workspaceId, descriptor, {
        signing,
        signal: controller.signal,
        deadlineAt: attemptDeadline,
        ensureCurrent,
      } satisfies RequestBlobOptions)
    assertRuntime(input, runId)
    await readUnchangedAuthority(input, originalAuthority)
    if (Date.now() >= attemptDeadline || Date.now() >= hardDeadline) throw new Error("Blob transfer deadline exceeded")
    if (!input.isCurrent(entry, runId)) {
      return { kind: "failure", error: new BlobFetchSessionReplaced(), sessionReplaced: true, retryNetwork: false }
    }
    // The blob store has no compare-and-write/remove primitive. If authority changes
    // while this awaited write commits, the post-write guards prevent a stale return,
    // but cannot roll back bytes already committed by the store.
    await input.blob.write(descriptor, bytes)
    assertRuntime(input, runId)
    if (Date.now() >= attemptDeadline || Date.now() >= hardDeadline) throw new Error("Blob transfer deadline exceeded")
    await readUnchangedAuthority(input, originalAuthority)
    if (Date.now() >= attemptDeadline || Date.now() >= hardDeadline) throw new Error("Blob transfer deadline exceeded")
    if (!input.isCurrent(entry, runId)) throw new BlobFetchAuthorityChanged("Mesh session changed while caching blob")
    return { kind: "success", bytes }
  } catch (error) {
    if (error instanceof BlobFetchAuthorityChanged) throw error
    assertRuntime(input, runId)
    await readUnchangedAuthority(input, originalAuthority)
    return {
      kind: "failure", error, sessionReplaced: !input.isCurrent(entry, runId),
      retryNetwork: error instanceof MeshNetworkError,
    }
  } finally {
    stopMonitor()
  }
}

function retryableBlobConnection(connection: SessionEntry["connection"]): SessionEntry["connection"] {
  return {
    ...connection,
    openStream: async () => {
      const stream = await connection.openStream()
      return {
        ...stream,
        read: async (maximumBytes?: number) => {
          const frame = await stream.read(maximumBytes)
          if (frame.byteLength === 0) throw new MeshNetworkError("Blob peer closed the response stream")
          return frame
        },
      }
    },
  }
}

function monitorBlobAttempt(
  input: {
    readAuthority(): Promise<BlobAuthoritySnapshot>
    isCurrent(entry: SessionEntry, runId: number): boolean
    currentRunId(): number
    isRunning(): boolean
  },
  entry: SessionEntry,
  runId: number,
  originalAuthority: BlobAuthoritySnapshot,
  controller: AbortController,
): () => void {
  let stopped = false
  let checking = false
  const check = async () => {
    if (stopped || checking || controller.signal.aborted) return
    checking = true
    try {
      assertRuntime(input, runId)
      await readUnchangedAuthority(input, originalAuthority)
      if (stopped) return
      if (!input.isCurrent(entry, runId)) controller.abort(new BlobFetchSessionReplaced())
    } catch (error) {
      if (!stopped && !controller.signal.aborted) controller.abort(error)
    } finally {
      checking = false
    }
  }
  const timer = setInterval(() => { void check() }, 250)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

async function readUnchangedAuthority(input: {
  readAuthority(): Promise<BlobAuthoritySnapshot>
}, original: BlobAuthoritySnapshot): Promise<BlobAuthoritySnapshot> {
  let current: BlobAuthoritySnapshot
  try { current = await input.readAuthority() }
  catch (error) {
    throw new BlobFetchAuthorityChanged(error instanceof Error ? error.message : "Workspace access changed during blob transfer", { cause: error })
  }
  if (current.identity !== original.identity || current.credential !== original.credential) {
    throw new BlobFetchAuthorityChanged("Workspace identity or credential changed during blob transfer")
  }
  return current
}

function assertRuntime(input: { currentRunId(): number; isRunning(): boolean }, runId: number): void {
  if (!input.isRunning() || input.currentRunId() !== runId) {
    throw new BlobFetchAuthorityChanged("Mesh runtime stopped or changed during blob transfer")
  }
}

function waitForNextSession(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 200))
}
