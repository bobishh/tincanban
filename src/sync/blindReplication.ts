import { blindHash, inventoryBlindObjects, downloadBlindObject, uploadBlindObject, type BlindAccess } from "./blindClient"
import { decodeBlindBytes, encodeBlindBytes, encryptBlindObject, decryptBlindObject } from "./blindEnvelope"
import { canonicalizeJson } from "../domain/identity"

export type BlindReplicaConfig = BlindAccess & { workspaceId: string; keyEpoch: number; contentKey: string; cursor: number; lastUploaded: string; removalPending?: boolean }
export type BlindReplicaStore = {
  read: (id: string) => Promise<Uint8Array>
  authorization: (bytes: Uint8Array, id: string) => Promise<unknown>
  merge: (id: string, bytes: Uint8Array, authorization: unknown) => Promise<void>
  readChat: (id: string) => Promise<unknown>
  mergeChat: (id: string, chat: unknown) => Promise<void>
  persist: (config: BlindReplicaConfig) => Promise<void>
  documentRevision?: (bytes: Uint8Array) => Promise<string>
  diagnostic?: (event: string, detail: Record<string, unknown>) => void
}
type Transport = { inventory: typeof inventoryBlindObjects; download: typeof downloadBlindObject; upload: typeof uploadBlindObject }
type Snapshot = { version: 1; workspaceId: string; document: string; authorization: unknown; chat: unknown }
const maximumPlaintextBytes = 16 * 1024 * 1024 - 16
type ContentParts = { document: string; authority: string; chat: string; revision?: string }
function changedParts(parts: ContentParts, previous?: ContentParts): string[] {
  if (!previous) return []
  const changed: string[] = (["document", "authority", "chat"] as const).filter(key => parts[key] !== previous[key])
  if (changed.includes("document") && previous.revision !== undefined && parts.revision === previous.revision) changed[changed.indexOf("document")] = "encoding"
  return changed
}
function uploadPhase(retry: boolean, known: boolean): string { return retry ? "retry" : known ? "changed" : "initial" }

/** Rusty supplies opaque bytes. Only the existing signed causal admission may merge them. */
export class BlindReplica {
  private receivedHash: string | undefined
  private previousParts: ContentParts | undefined
  private receivedParts: ContentParts | undefined
  private pending: { hash: string; object: Awaited<ReturnType<typeof encryptBlindObject>> } | undefined
  constructor(private readonly config: BlindReplicaConfig, private readonly store: BlindReplicaStore,
    private readonly transport: Transport = { inventory: inventoryBlindObjects, download: downloadBlindObject, upload: uploadBlindObject }) {}

  async pull(): Promise<boolean> {
    // Bound each pass; continue large inventories on the next scheduled pass.
    for (let page = 0; page < 8; page++) {
      const inventory = await this.transport.inventory(this.config, this.config.cursor)
      for (const entry of inventory.objects) {
        const object = await this.transport.download(this.config, entry.objectId)
        const plaintext = await decryptBlindObject(object, this.config.scopeId, this.config.keyEpoch, decodeBlindBytes(this.config.contentKey))
        if (plaintext.length > maximumPlaintextBytes) throw new Error("Encrypted snapshot exceeds client limit")
        const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as Snapshot
        if (snapshot.version !== 1 || snapshot.workspaceId !== this.config.workspaceId || typeof snapshot.document !== "string" || !snapshot.authorization) {
          throw new Error("Encrypted snapshot does not match this workspace")
        }
        await this.store.merge(this.config.workspaceId, decodeBlindBytes(snapshot.document), snapshot.authorization)
        if (snapshot.chat != null) await this.store.mergeChat(this.config.workspaceId, snapshot.chat)
        // Cursor follows durable admission; failures retry the same object.
        const next = { ...this.config, cursor: entry.sequence }
        await this.store.persist(next)
        this.config.cursor = next.cursor
        this.receivedHash = await blindHash(new TextEncoder().encode(canonicalizeJson(snapshot)))
        this.receivedParts = await this.parts(snapshot)
      }
      if (!inventory.hasMore) return true
    }
    return false
  }

  async push(): Promise<void> {
    const bytes = await this.store.read(this.config.workspaceId)
    const snapshot: Snapshot = { version: 1, workspaceId: this.config.workspaceId, document: encodeBlindBytes(bytes),
      authorization: await this.store.authorization(bytes, this.config.workspaceId), chat: await this.store.readChat(this.config.workspaceId) }
    const plaintext = new TextEncoder().encode(canonicalizeJson(snapshot))
    if (plaintext.length > maximumPlaintextBytes) throw new Error("Workspace snapshot exceeds Rusty object limit")
    const hash = await blindHash(plaintext)
    if (hash === this.config.lastUploaded) {
      this.observe("mesh.rusty.upload.skipped", { phase: "unchanged", bytes: plaintext.length })
      return
    }
    if (hash === this.receivedHash) {
      // Already durable and admitted; do not echo remote state as fresh ciphertext.
      await this.acknowledgeStored(hash, this.receivedParts, "remote_already_stored", plaintext.length)
      return
    }
    const parts = await this.parts(snapshot)
    const previous = this.previousParts ?? this.receivedParts
    const changedFields = changedParts(parts, previous)
    if (changedFields.length === 1 && changedFields[0] === "encoding") {
      await this.acknowledgeStored(hash, parts, "encoding_unchanged_state", plaintext.length)
      return
    }
    const retry = this.pending?.hash === hash
    const phase = uploadPhase(retry, previous !== undefined)
    if (this.pending?.hash !== hash) this.pending = { hash, object: await encryptBlindObject(this.config.scopeId, this.config.keyEpoch, decodeBlindBytes(this.config.contentKey), plaintext) }
    // Transport validates the signed durable receipt before acknowledging anything locally.
    this.observe("mesh.rusty.upload.started", { phase, changedFields, bytes: plaintext.length })
    try { await this.transport.upload(this.config, this.pending.object) }
    catch (error) { this.observe("mesh.rusty.upload.failed", { phase: "delivery", bytes: plaintext.length }); throw error }
    const next = { ...this.config, lastUploaded: hash }
    await this.store.persist(next)
    this.config.lastUploaded = hash
    this.pending = undefined
    this.previousParts = parts
    this.observe("mesh.rusty.upload.completed", { phase, changedFields, bytes: plaintext.length })
  }

  private async acknowledgeStored(hash: string, parts: ContentParts | undefined, phase: string, bytes: number) {
    await this.store.persist({ ...this.config, lastUploaded: hash })
    this.config.lastUploaded = hash
    this.pending = undefined
    this.previousParts = parts
    this.observe("mesh.rusty.upload.skipped", { phase, bytes })
  }

  private async parts(snapshot: Snapshot): Promise<ContentParts> {
    const [document, authority, chat, revision] = await Promise.all([
      blindHash(new TextEncoder().encode(snapshot.document)),
      blindHash(new TextEncoder().encode(canonicalizeJson(snapshot.authorization))),
      blindHash(new TextEncoder().encode(canonicalizeJson(snapshot.chat))),
      this.store.documentRevision?.(decodeBlindBytes(snapshot.document)).catch(() => undefined),
    ])
    return { document, authority, chat, ...(revision !== undefined ? { revision } : {}) }
  }

  private observe(event: string, detail: Record<string, unknown>) {
    try { this.store.diagnostic?.(event, { workspaceId: this.config.workspaceId, entityType: "scope", entityId: this.config.scopeId, component: "rusty", operation: "upload", ...detail }) }
    catch { /* Diagnostic failures must not affect durable replication. */ }
  }

  async sync(): Promise<boolean> { const caughtUp = await this.pull(); await this.push(); return caughtUp }
}
