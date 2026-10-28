import { inspectPairingFrame } from "@meta-uber/mesh-pairing"
import { createLiveWorkspaceSession } from "@meta-uber/mesh-runtime"
import { fromBase64Url } from "../domain/identity"
import { workspaceProofTransfer } from "./workspaceProofTransfer"
import type { WorkspaceSetStore, OwnerWorkspaceOfferFrame } from "./workspaceSet"
import type { DuplexStream, SyncConnection } from "./transport"
import { meshIngressPayloadLimit, meshIngressTransferDeadlineMs } from "../iroh"

type Source = ReturnType<typeof workspaceProofTransfer>
type Pending = { manifest: string; source: Source; ensureCurrent: () => Promise<void> }
const pending = new WeakMap<SyncConnection, Map<string, Pending>>()
export class OwnerOfferAccessDenied extends Error {}

export async function publishOwnerWorkspaceOffer(connection: SyncConnection, secret: string, bytes: Uint8Array,
  frame: OwnerWorkspaceOfferFrame, ensureCurrent: () => Promise<void>): Promise<void> {
  const protocol = createLiveWorkspaceSession("workspace-set", secret)
  try {
    let response: Uint8Array | undefined
    if (bytes.byteLength <= meshIngressPayloadLimit("mesh-owner-workspace-offer")) {
      response = await exchangeOwnerFrame(connection, protocol.encode("mesh-owner-workspace-offer", bytes),
        meshIngressTransferDeadlineMs(), ensureCurrent)
    } else {
      if (frame !== "mesh-owner-workspace-offer-page-v1") {
        throw new Error("Peer does not support bounded owner workspace offers")
      }
      const pages = protocol.encodeOwnerWorkspaceOfferPages(bytes)
      const deadline = Date.now() + meshIngressTransferDeadlineMs()
      for (let index = 0; index < pages.length; index++) {
        response = await exchangeOwnerFrame(connection, pages[index]!, Math.max(1, deadline - Date.now()), ensureCurrent)
        if (response.byteLength > 0) break
        if (index === pages.length - 1) throw new Error("Owner workspace offer was not durably acknowledged")
      }
    }
    if (!response?.byteLength) throw new Error("Owner workspace offer was not durably acknowledged")
    let outgoing: Uint8Array
    for (let round = 0; round <= 4096; round++) {
      if (inspectPairingFrame(response).type !== "mesh-proof-request-v1") {
        protocol.verifySavedReceipt(response, bytes)
        return
      }
      if (round === 4096) throw new Error("Owner proof reply limit exceeded")
      let page: Uint8Array | undefined
      const handled = await serveOwnerOfferProofs(connection, secret, {
        send: async value => { page = value }, closeSend: async () => {},
        read: async () => { throw new Error("Owner proof source cannot read") },
      }, response)
      if (!handled || !page) {
        await ensureCurrent()
        throw new Error("Native requested proofs outside approved owner offer")
      }
      outgoing = page
      response = await exchangeOwnerFrame(connection, outgoing, Math.min(20_000,
        meshIngressTransferDeadlineMs()), ensureCurrent)
    }
    throw new Error("Owner proof reply limit exceeded")
  } finally { protocol.free?.() }
}

async function exchangeOwnerFrame(connection: SyncConnection, frame: Uint8Array, timeoutMs: number,
  ensureCurrent: () => Promise<void>): Promise<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stream: DuplexStream | undefined
  try {
    return await Promise.race([(async () => {
      await ensureCurrent()
      stream = await connection.openStream()
      await ensureCurrent()
      await stream.send(frame)
      await stream.closeSend()
      return stream.read()
    })(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (stream?.reset) void stream.reset().catch(() => connection.close().catch(() => undefined))
        else void connection.close().catch(() => undefined)
        reject(new Error("Owner delivery is unconfirmed; retry the same offer"))
      }, timeoutMs)
    })])
  } catch (error) {
    await stream?.reset?.().catch(() => undefined)
    throw error
  } finally { if (timer) clearTimeout(timer) }
}

/** Called only after the authenticated owner/future-board policy approves an
 * outgoing offer. Requests can read only its exact frozen manifest on this
 * connection and existing transport secret, never an arbitrary workspace. */
export async function registerOwnerOfferProofs(connection: SyncConnection, secret: string,
  bytes: Uint8Array, store: WorkspaceSetStore, ensureCurrent: () => Promise<void>): Promise<() => void> {
  await ensureCurrent()
  const offer = JSON.parse(new TextDecoder().decode(bytes)) as {
    workspaceId: string; workspace: { id: string; bytes: string; authorization?: { kind?: string; transferId?: string } }
  }
  const manifest = offer.workspace.authorization
  if (manifest?.kind !== "workspace-authorization-manifest") return () => {}
  if (offer.workspace.id !== offer.workspaceId || !manifest.transferId || !store.readAuthorization) {
    throw new Error("Invalid approved owner proof source")
  }
  const document = fromBase64Url(offer.workspace.bytes)
  const authorization = await store.readAuthorization(document, offer.workspaceId)
  await ensureCurrent()
  const source = workspaceProofTransfer({ ...store,
    read: async id => {
      if (id !== offer.workspaceId) throw new Error("Proof workspace outside approved owner offer")
      return document
    },
    readAuthorization: async () => authorization,
  }, [offer.workspaceId])
  const key = `${secret}\0${manifest.transferId}`
  const entries = pending.get(connection) ?? new Map<string, Pending>()
  if (entries.has(key)) throw new Error("Owner proof transfer already pending")
  const entry = { manifest: canonical(manifest), source, ensureCurrent }
  entries.set(key, entry)
  pending.set(connection, entries)
  return () => {
    if (entries.get(key) === entry) entries.delete(key)
    source.closeProofSources()
  }
}

export async function serveOwnerOfferProofs(connection: SyncConnection, secret: string,
  stream: DuplexStream, frame: Uint8Array): Promise<boolean> {
  const header = inspectPairingFrame(frame)
  if (header.type !== "mesh-proof-request-v1") return false
  if (header.secret !== secret || frame.length > 256 * 1024) throw new Error("Unauthorized owner proof request")
  const request = JSON.parse(new TextDecoder().decode(frame.subarray(frame.indexOf(10) + 1))) as {
    manifest?: { transferId?: string }
  }
  const entry = pending.get(connection)?.get(`${secret}\0${request.manifest?.transferId}`)
  if (!entry) return false
  if (canonical(request.manifest) !== entry.manifest) throw new Error("Owner proof request changed approved manifest")
  try {
    await entry.ensureCurrent()
    return await entry.source.serveProofPage(frame, { read: () => stream.read(), closeSend: () => stream.closeSend(),
      send: async bytes => { await entry.ensureCurrent(); await stream.send(bytes) } }, secret)
  } catch (error) {
    if (!(error instanceof OwnerOfferAccessDenied)) throw error
    await stream.closeSend()
    return true
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
