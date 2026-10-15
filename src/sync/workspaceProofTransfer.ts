import * as Automerge from "@automerge/automerge/slim"
import { inspectPairingFrame } from "@meta-uber/mesh-pairing"
import { meshRustRuntime, type RustMeshScopeFrameEffect, type RustMeshScopeRuntime } from "@meta-uber/mesh-replication/runtime"
import { fromBase64Url } from "../domain/identity"
import { readProofPage, writeProofPage, clearProofPages } from "./proofPageCache"
import type { DuplexStream, SyncConnection } from "./transport"
import type { WorkspaceSetStore } from "./workspaceSet"

type Entry = { id: string; bytes: string; authorization?: unknown }
type RequestEffect = Extract<RustMeshScopeFrameEffect, { kind: "proofRequest" }>
const MAX_PROOF_FRAME_BYTES = 256 * 1024

export function workspaceProofTransfer(store: WorkspaceSetStore, ids: string[]) {
  const sources = new Map<string, RustMeshScopeRuntime>()
  return {
    closeProofSources() {
      for (const runtime of sources.values()) runtime.free?.()
      sources.clear()
    },
    async serveProofPage(frame: Uint8Array, stream: DuplexStream, secret: string,
      ensureCurrent: () => void | Promise<void> = () => undefined): Promise<boolean> {
      const id = requestWorkspace(frame, secret, ids)
      if (!id) return false
      const key = `${id}:${secret}`
      const runtime = sourceRuntime(sources, key, id, secret)
      try {
        await ensureCurrent()
        const effect = runtime.receiveFrame(frame)
        if (effect?.kind !== "proofSource") throw new Error("Invalid proof request")
        const payload = Uint8Array.from(effect.payload)
        const response = runtime.provideCachedProofPage(payload)
          ?? await prepareSourcePage(store, id, runtime, payload, ensureCurrent)
        await ensureCurrent()
        await stream.send(Uint8Array.from(response))
        await stream.closeSend()
        return true
      } catch (error) {
        runtime.free?.()
        sources.delete(key)
        try { await stream.reset?.() } catch { /* Preserve the authorization failure. */ }
        throw error
      }
    },
    async resolveProofs(bytes: Uint8Array, connection?: SyncConnection, secret = "local-preflight"): Promise<Uint8Array> {
      const entries = meshRustRuntime().state.decodeWorkspaceSet(bytes, ids)
      for (const entry of entries) {
        if (isManifest(entry.authorization)) entry.authorization = await resolveEntry(entry, store, connection, secret)
      }
      return meshRustRuntime().state.encodeWorkspaceSet(entries)
    },
  }
}

function requestWorkspace(frame: Uint8Array, secret: string, ids: string[]): string | undefined {
  const header = inspectPairingFrame(frame)
  if (header.type !== "mesh-proof-request-v1") return undefined
  if (header.secret !== secret || frame.length > MAX_PROOF_FRAME_BYTES) throw new Error("Unauthorized proof request")
  const request = JSON.parse(new TextDecoder().decode(frame.subarray(frame.indexOf(10) + 1))) as { manifest?: { workspaceId?: string } }
  const id = request.manifest?.workspaceId
  if (!id || !ids.includes(id)) throw new Error("Proof workspace outside invitation scope")
  return id
}
function sourceRuntime(sources: Map<string, RustMeshScopeRuntime>, key: string, id: string, secret: string): RustMeshScopeRuntime {
  const cached = sources.get(key)
  if (cached) return cached
  if (sources.size >= 4) {
    const oldest = sources.keys().next().value!
    sources.get(oldest)?.free?.()
    sources.delete(oldest)
  }
  const runtime = meshRustRuntime().createMeshScopeRuntime(id, secret)
  sources.set(key, runtime)
  return runtime
}
async function prepareSourcePage(store: WorkspaceSetStore, id: string, runtime: RustMeshScopeRuntime, payload: Uint8Array,
  ensureCurrent: () => void | Promise<void>) {
  if (!store.readAuthorization) throw new Error("Proof workspace outside invitation scope")
  await ensureCurrent()
  const document = await store.read(id)
  await ensureCurrent()
  const authorization = await store.readAuthorization(document, id)
  await ensureCurrent()
  return runtime.provideProofPage(payload, document, authorization)
}
async function localDocument(store: WorkspaceSetStore, id: string): Promise<Uint8Array> {
  try { return await store.read(id) }
  catch {
    const empty = Automerge.init()
    try { return Automerge.save(empty) } finally { Automerge.free(empty) }
  }
}
async function resolveEntry(entry: Entry, store: WorkspaceSetStore, connection: SyncConnection | undefined, secret: string): Promise<unknown> {
  const runtime = meshRustRuntime().createMeshScopeRuntime(entry.id, secret)
  try {
    let effect = runtime.beginAuthorizationTransfer(fromBase64Url(entry.bytes), await localDocument(store, entry.id), entry.authorization)
    for (let rounds = 0; rounds < 4096; rounds++) {
      if (effect.kind === "documentReceive") return effect.proof
      if (effect.kind === "proofPageReceived") {
        await writeProofPage(entry.id, effect.cacheKey, Uint8Array.from(effect.payload)).catch(() => {})
        effect = runtime.continueProofReceive()
        continue
      }
      if (effect.kind !== "proofRequest") throw new Error("Unexpected proof transfer state")
      effect = await receivePage(runtime, entry.id, effect, connection)
    }
    throw new Error("Proof transfer exceeded page limit")
  } finally { runtime.free?.() }
}
async function receivePage(runtime: RustMeshScopeRuntime, id: string, effect: RequestEffect, connection?: SyncConnection): Promise<RustMeshScopeFrameEffect> {
  const cached = await readProofPage(id, effect.cacheKey).catch(() => undefined)
  if (cached) {
    try { return runtime.acceptProofPage(cached) }
    catch { await clearProofPages(id).catch(() => {}) }
  }
  if (!connection) throw new Error("Workspace authorization pages required before admission")
  const frame = await readProofResponse(connection, Uint8Array.from(effect.frame))
  const next = runtime.receiveFrame(frame)
  if (!next) throw new Error("Missing proof page response")
  return next
}
function isManifest(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "workspace-authorization-manifest")
}
export function exportWorkspaceProofs(document: Uint8Array, value: unknown): unknown {
  if (!value || typeof value !== "object" || !("authority" in value) || (!("records" in value) && !("pages" in value))) return value
  return meshRustRuntime().state.authorizationExport(document, value)
}
async function readProofResponse(connection: SyncConnection, frame: Uint8Array): Promise<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stream: DuplexStream | undefined
  let expired = false
  let sendClosed = false
  const ensurePending = () => { if (expired) throw new Error("Authorization page timed out; retry same snapshot") }
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(new Error("Authorization page timed out; retry same snapshot"))
    }, 20_000)
  })
  const operation = (async () => {
    const opened = await connection.openStream()
    if (expired) { releaseProofStream(opened, true); ensurePending() }
    stream = opened
    await stream.send(frame)
    ensurePending()
    await stream.closeSend()
    sendClosed = true
    ensurePending()
    const response = await stream.read(MAX_PROOF_FRAME_BYTES)
    ensurePending()
    if (response.length > MAX_PROOF_FRAME_BYTES) throw new Error("Authorization page response is too large")
    return response
  })()
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (stream) releaseProofStream(stream, !sendClosed)
  }
}

function releaseProofStream(stream: DuplexStream, closeSend: boolean): void {
  try {
    if (stream.reset) void Promise.resolve(stream.reset()).catch(() => undefined)
    else if (closeSend) void Promise.resolve(stream.closeSend()).catch(() => undefined)
  } catch { /* Cleanup must not replace the transfer result. */ }
}
