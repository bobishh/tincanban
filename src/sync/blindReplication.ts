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
}
type Transport = { inventory: typeof inventoryBlindObjects; download: typeof downloadBlindObject; upload: typeof uploadBlindObject }
type Snapshot = { version: 1; workspaceId: string; document: string; authorization: unknown; chat: unknown }
const maximumPlaintextBytes = 16 * 1024 * 1024 - 16

/** Rusty supplies opaque bytes. Only the existing signed causal admission may merge them. */
export class BlindReplica {
  private receivedHash: string | undefined
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
    if (hash === this.config.lastUploaded) return
    if (hash === this.receivedHash) {
      // Already durable and admitted; do not echo remote state as fresh ciphertext.
      await this.store.persist({ ...this.config, lastUploaded: hash })
      this.config.lastUploaded = hash
      this.pending = undefined
      return
    }
    if (this.pending?.hash !== hash) this.pending = { hash, object: await encryptBlindObject(this.config.scopeId, this.config.keyEpoch, decodeBlindBytes(this.config.contentKey), plaintext) }
    // Transport validates the signed durable receipt before acknowledging anything locally.
    await this.transport.upload(this.config, this.pending.object)
    const next = { ...this.config, lastUploaded: hash }
    await this.store.persist(next)
    this.config.lastUploaded = hash
    this.pending = undefined
  }

  async sync(): Promise<boolean> { const caughtUp = await this.pull(); await this.push(); return caughtUp }
}
