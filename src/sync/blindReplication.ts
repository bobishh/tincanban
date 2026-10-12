import { blindHash, inventoryBlindObjects, downloadBlindObject, uploadBlindObject, type BlindAccess } from "./blindClient"
import { decodeBlindBytes, encodeBlindBytes, encryptBlindObject, decryptBlindObject } from "./blindEnvelope"
import type { BlindCheckpointRequest, submitBlindCheckpoint } from "./blindCheckpoint"
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
  checkpointAllowed?: (request?: BlindCheckpointRequest) => Promise<boolean>
  prepareCheckpoint?: (bytes: Uint8Array, object: Awaited<ReturnType<typeof encryptBlindObject>>, expectedSequence: number) => Promise<BlindCheckpointRequest | undefined>
  diagnostic?: (event: string, detail: Record<string, unknown>) => void
}
type Transport = { inventory: typeof inventoryBlindObjects; download: typeof downloadBlindObject; upload: typeof uploadBlindObject; checkpoint?: typeof submitBlindCheckpoint }
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
  private retainedObjects = 0
  private checkpointSequence = 0
  private checkpointPending: { hash: string; parts: ContentParts; bytes: number; request: BlindCheckpointRequest } | undefined
  private pending: { hash: string; object: Awaited<ReturnType<typeof encryptBlindObject>> } | undefined
  constructor(private readonly config: BlindReplicaConfig, private readonly store: BlindReplicaStore,
    private readonly transport: Transport = { inventory: inventoryBlindObjects, download: downloadBlindObject, upload: uploadBlindObject,
      checkpoint: async (access, request) => (await import("./blindCheckpoint")).submitBlindCheckpoint(access, request) }) {}

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
      if (!inventory.hasMore) {
        this.retainedObjects = inventory.objectCount ?? 0
        this.checkpointSequence = inventory.maxSequence ?? this.config.cursor
        return true
      }
    }
    return false
  }

  async push(): Promise<void> {
    const { snapshot, plaintext, hash } = await this.snapshot()
    if (hash === this.config.lastUploaded) {
      this.previousParts ??= await this.parts(snapshot)
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

  private async snapshot() {
    const bytes = await this.store.read(this.config.workspaceId)
    const snapshot: Snapshot = { version: 1, workspaceId: this.config.workspaceId, document: encodeBlindBytes(bytes),
      authorization: await this.store.authorization(bytes, this.config.workspaceId), chat: await this.store.readChat(this.config.workspaceId) }
    const plaintext = new TextEncoder().encode(canonicalizeJson(snapshot))
    if (plaintext.length > maximumPlaintextBytes) throw new Error("Workspace snapshot exceeds Rusty object limit")
    return { bytes, snapshot, plaintext, hash: await blindHash(plaintext) }
  }

  private checkpointAvailable(): boolean {
    return !!(this.store.prepareCheckpoint && this.store.checkpointAllowed && this.transport.checkpoint &&
      (this.checkpointPending || this.retainedObjects >= 8))
  }

  private async prepareCheckpointState(): Promise<boolean> {
    const allowed = this.store.checkpointAllowed!
    if (!await allowed(this.checkpointPending?.request)) {
      this.checkpointPending = undefined
      this.observe("mesh.rusty.checkpoint.skipped", { phase: "admission_incomplete" })
      return false
    }
    if ((this.checkpointPending?.request.authorization.payload.expiresAt ?? Infinity) <= Date.now()) this.checkpointPending = undefined
    if (!this.checkpointPending) {
      const { bytes, snapshot, plaintext, hash } = await this.snapshot()
      const object = await encryptBlindObject(this.config.scopeId, this.config.keyEpoch, decodeBlindBytes(this.config.contentKey), plaintext)
      const request = await this.store.prepareCheckpoint!(bytes, object, this.checkpointSequence)
      if (!request) return false
      this.checkpointPending = { hash, request, bytes: plaintext.length, parts: await this.parts(snapshot) }
    }
    // Signatures do not override local ownership/admission changes during preparation.
    if (!await allowed(this.checkpointPending.request)) { this.checkpointPending = undefined; return false }
    return true
  }

  private async checkpoint(): Promise<"skipped" | "completed" | "conflict"> {
    if (!this.checkpointAvailable() || !await this.prepareCheckpointState()) return "skipped"
    const pending = this.checkpointPending!
    this.observe("mesh.rusty.checkpoint.started", { phase: "replacement", bytes: pending.bytes })
    let sequence: number
    try { sequence = (await this.transport.checkpoint!(this.config, pending.request)).payload.sequence }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "checkpoint_conflict") {
        this.checkpointPending = undefined
        this.observe("mesh.rusty.checkpoint.skipped", { phase: "concurrent_writer" })
        return "conflict"
      }
      this.observe("mesh.rusty.checkpoint.failed", { phase: "delivery", bytes: pending.bytes })
      throw error
    }
    const next = { ...this.config, cursor: Math.max(this.config.cursor, sequence), lastUploaded: pending.hash }
    await this.store.persist(next)
    this.config.cursor = next.cursor
    this.config.lastUploaded = next.lastUploaded
    this.previousParts = pending.parts
    this.pending = undefined
    this.checkpointPending = undefined
    this.retainedObjects = 1
    this.observe("mesh.rusty.checkpoint.completed", { phase: "replacement", bytes: pending.bytes })
    return "completed"
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
      this.documentRevision(decodeBlindBytes(snapshot.document)),
    ])
    return { document, authority, chat, ...(revision !== undefined ? { revision } : {}) }
  }

  private async documentRevision(bytes: Uint8Array): Promise<string | undefined> {
    try { return await this.store.documentRevision?.(bytes) }
    catch (error) {
      const errorCode = error instanceof RangeError ? "revision_invalid_document" : error instanceof TypeError ? "revision_invalid_type" : "revision_unavailable"
      this.observe("mesh.rusty.revision.failed", { phase: "revision", errorCode })
      return undefined
    }
  }

  private observe(event: string, detail: Record<string, unknown>) {
    try { this.store.diagnostic?.(event, { workspaceId: this.config.workspaceId, entityType: "scope", entityId: this.config.scopeId, component: "rusty", operation: event.includes("checkpoint") ? "checkpoint" : event.includes("revision") ? "revision" : "upload", ...detail }) }
    catch { /* Diagnostic failures must not affect durable replication. */ }
  }

  async sync(): Promise<boolean> {
    const caughtUp = await this.pull()
    if (caughtUp) {
      const result = await this.checkpoint()
      if (result === "conflict") return false
      if (result === "completed") return true
    }
    await this.push()
    return caughtUp
  }
}
