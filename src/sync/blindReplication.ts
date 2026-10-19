import { blindHash, inventoryBlindObjects, downloadBlindObject, uploadBlindObject, verifyBlindReceipt, type BlindReceipt, type BlindAccess } from "./blindClient"
import { decodeBlindBytes, encodeBlindBytes, encryptBlindObject, decryptBlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import type { BlindCheckpointRequest, submitBlindCheckpoint } from "./blindCheckpoint"
import { canonicalizeJson } from "../domain/identityCrypto"
import { ReplicaEngine, emptyReplicaState, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import type { BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import type { BlindCheckpointRequest as HistoryCheckpointRequest } from "./blindCheckpoint"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import type { AttachmentLocator } from "../product-replica"
import { openWithReplicaContentKeys } from "./replicaContentKeys"

import type { BlindReplicaConfig } from "../product-replica/config"
export type { BlindReplicaConfig } from "../product-replica/config"
export type PrivateReplicaConflictSummary = { origin: string; scopeId: string; workspaceIds: string[]; identityState: boolean }
export type BlindReplicaStore = {
  read: (id: string) => Promise<Uint8Array>
  authorization: (bytes: Uint8Array, id: string) => Promise<unknown>
  merge: (id: string, bytes: Uint8Array, authorization: unknown) => Promise<void>
  readChat: (id: string) => Promise<unknown>
  mergeChat: (id: string, chat: unknown) => Promise<void>
  persist: (config: BlindReplicaConfig) => Promise<void>
  replicaBinding?: string
  readReplicaProgress?: () => Promise<ReplicaState<BlindObject>>
  persistReplicaProgress?: (expected: number, next: ReplicaState<BlindObject>) => Promise<void>
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>
  ensureCurrent?: () => void | Promise<void>
  ensureIdentity?: () => void
  documentRevision?: (bytes: Uint8Array) => Promise<string>
  readSnapshotRevision?: (id: string) => Promise<string | undefined>
  readAttachments?: (id: string) => Promise<AttachmentLocator[]>
  mergeAttachments?: (id: string, locators: AttachmentLocator[]) => Promise<void>
  readAttachmentRevision?: (id: string) => Promise<string | undefined>
  readHistoryRevision?: (id: string) => Promise<string | undefined>
  prepareAttachments?: () => Promise<void>
  /** Owner-signed compact history descriptor; implementations must return only durably covered state. */
  readHistoryBaseline?: (id: string) => Promise<unknown | undefined>
  /** Verify and atomically admit the compact basis before publishing its projection. */
  receiveHistoryBaseline?: (id: string, document: Uint8Array, authorization: unknown, history: unknown) => Promise<void>
  prepareHistoryCheckpoint?: (bytes: Uint8Array, object: BlindObject, expectedSequence: number, baselineId: string, existing?: HistoryCheckpointRequest, candidate?: WasmVerifiedReceivedHistoryBaseline, history?: unknown) => Promise<HistoryCheckpointRequest>
  checkpointAllowed?: (request?: BlindCheckpointRequest) => Promise<boolean>
  prepareCheckpoint?: (bytes: Uint8Array, object: Awaited<ReturnType<typeof encryptBlindObject>>, expectedSequence: number) => Promise<BlindCheckpointRequest | undefined>
  diagnostic?: (event: string, detail: Record<string, unknown>) => void
  operation?: <T>(name: string, operation: () => Promise<T>) => Promise<T>
}
type Transport = { inventory: typeof inventoryBlindObjects; download: typeof downloadBlindObject; upload: (access: BlindAccess, object: BlindObject, requestId: string, observedSequence?: number) => Promise<BlindReceipt>; checkpoint?: typeof submitBlindCheckpoint }
type Snapshot = { version: 1 | 2; workspaceId: string; document: string; authorization: unknown; chat: unknown;
  attachments?: AttachmentLocator[]; history?: unknown }
const maximumPlaintextBytes = 16 * 1024 * 1024 - 16
type ContentParts = { document: string; authority: string; chat: string; attachments?: string; history?: string; revision?: string }
function changedParts(parts: ContentParts, previous?: ContentParts): string[] {
  if (!previous) return []
  const changed: string[] = (["document", "authority", "chat", "attachments", "history"] as const).filter(key => parts[key] !== previous[key])
  if (changed.includes("document") && previous.revision !== undefined && parts.revision === previous.revision) changed[changed.indexOf("document")] = "encoding"
  return changed
}
function uploadPhase(retry: boolean, known: boolean): string { return retry ? "retry" : known ? "changed" : "initial" }
async function readAttachmentLocators(value: unknown): Promise<AttachmentLocator[]> {
  if (value === undefined) return []
  return (await import("../product-replica/attachmentIndex")).parseAttachmentLocators(value)
}

/** Rusty supplies opaque bytes. Only the existing signed causal admission may merge them. */
export class BlindReplica {
  private receivedHash: string | undefined
  private previousParts: ContentParts | undefined
  private receivedParts: ContentParts | undefined
  private retainedObjects = 0
  private checkpointSequence = 0
  private checkpointPending: { hash: string; parts: ContentParts; bytes: number; request: BlindCheckpointRequest } | undefined
  private readonly engine: ReplicaEngine<Uint8Array, BlindObject, BlindReceipt>
  private memoryProgress: ReplicaState<BlindObject>
  private readonly accessBinding: string
  private capturedParts?: ContentParts
  private capturedHash?: string
  private freshUpload = false
  private operations: Promise<unknown> = Promise.resolve()
  constructor(private readonly config: BlindReplicaConfig, private readonly store: BlindReplicaStore,
    private readonly transport: Transport = { inventory: inventoryBlindObjects, download: downloadBlindObject, upload: uploadBlindObject,
      checkpoint: async (access, request) => (await import("./blindCheckpoint")).submitBlindCheckpoint(access, request) }) {
    this.accessBinding = this.credentialBinding()
    const binding = store.replicaBinding ?? this.accessBinding
    this.memoryProgress = emptyReplicaState(binding, config.cursor, config.lastUploaded)
    this.engine = new ReplicaEngine(binding, {
      repository: { read: () => this.readProgress(), commit: (expected, next) => this.persistProgress(expected, next) },
      content: { revision: () => this.snapshotRevision(), capture: () => this.phase("snapshot", () => this.captureSnapshot()),
        seal: plaintext => this.phase("encrypt", () => encryptBlindObject(config.scopeId, config.keyEpoch, decodeBlindBytes(config.contentKey), plaintext)) },
      transport: { inventory: cursor => this.phase("inventory", () => transport.inventory({ ...config }, cursor)),
        download: id => this.phase("download", () => transport.download({ ...config }, id)), upload: (object, requestId, observedSequence) => this.upload(object, requestId, observedSequence) },
      admit: object => this.receiveSnapshot(object),
      verifyReceipt: (receipt, object, requestId) => verifyBlindReceipt(receipt, config, object, requestId),
      guard: () => this.ensureCurrent(),
      observe: (_event, detail) => this.observeProgress(detail),
    })
  }

  private credentialBinding(): string {
    const config = this.config
    const fields: unknown[] = [config.origin, config.workspaceId, config.scopeId, config.keyEpoch, config.policyRevision,
      config.servicePublicKey, config.readToken, config.writeToken, config.contentKey, config.preferenceRevision]
    if (config.historicalContentKeys) fields.push({ historicalContentKeys: config.historicalContentKeys })
    if (config.historicalContentKeyVariants) fields.push({ historicalContentKeyVariants: config.historicalContentKeyVariants })
    return canonicalizeJson(fields)
  }

  private async ensureCurrent() {
    if (this.credentialBinding() !== this.accessBinding) throw new Error("Rusty credential binding changed during replication")
    await this.store.ensureCurrent?.()
  }

  private async readProgress() { return this.store.readReplicaProgress ? this.store.readReplicaProgress() : this.memoryProgress }

  private async persistProgress(expected: number, next: ReplicaState<BlindObject>) {
    if (this.store.persistReplicaProgress) await this.store.persistReplicaProgress(expected, next)
    else {
      if (this.memoryProgress.generation !== expected) throw new Error("Replica progress changed during persistence")
      await this.store.persist({ ...this.config, cursor: next.cursor, lastUploaded: next.lastUploaded })
      this.memoryProgress = structuredClone(next)
    }
    this.config.cursor = next.cursor
    this.config.lastUploaded = next.lastUploaded
  }

  private schedule<T>(run: () => Promise<T>): Promise<T> {
    const exclusive = () => this.store.runExclusive ? this.store.runExclusive(run) : run()
    const next = this.operations.then(exclusive, exclusive)
    this.operations = next.then(() => undefined, () => undefined)
    return next
  }

  pull(): Promise<boolean> { return this.schedule(() => this.pullNow()) }

  private async pullNow(): Promise<boolean> {
    const caughtUp = await this.engine.pull()
    const inventory = this.engine.inventoryStatus()
    if (caughtUp && inventory) {
      this.retainedObjects = inventory.objectCount ?? 0
      this.checkpointSequence = inventory.maxSequence ?? inventory.cursor
    }
    return caughtUp
  }

  push(): Promise<void> { return this.schedule(async () => { await this.store.prepareAttachments?.(); await this.engine.push() }) }

  /** Maintenance retries saved ciphertext without preparing attachments or serializing a fresh snapshot. */
  drainPending(): Promise<boolean> { return this.schedule(() => this.engine.drainPending()) }

  /** The frozen history transition owns the original storage fence and durable replacement request. */
  checkpointHistoryBaseline(owner: string, transitionId: string, baselineId: string,
    candidate?: WasmVerifiedReceivedHistoryBaseline, history?: unknown): Promise<void> {
    return this.schedule(async () => {
      if ((await this.readProgress()).pending) throw new Error("Drain the original outbox before history checkpoint")
      const { publishHistoryStorageCheckpoint } = await import("./blindHistoryCheckpoint")
      const result = await publishHistoryStorageCheckpoint(owner, this.config, transitionId, baselineId, {
        guard: () => { this.store.ensureIdentity?.() }, ensureCurrent: () => this.ensureCurrent(),
        capture: () => this.snapshot(candidate?.document(), history),
        prepare: async (bytes, object, sequence, id, existing) => {
          await this.ensureCurrent()
          if (!this.store.prepareHistoryCheckpoint) throw new Error("History checkpoint validation is unavailable")
          return this.store.prepareHistoryCheckpoint(bytes, object, sequence, id, existing, candidate, history)
        },
        submit: request => this.transport.checkpoint!(this.config, request),
      })
      await this.ensureCurrent()
      if (candidate) return
      const progress = await this.readProgress()
      if (progress.pending) throw new Error("History checkpoint cannot replace a pending original upload")
      await this.persistProgress(progress.generation, { ...progress, generation: progress.generation + 1,
        cursor: Math.max(progress.cursor, result.sequence), lastUploaded: result.hash, uploadedRevision: undefined })
    })
  }

  /** Confirm the current locator index as well as any older uncertain upload before file coverage completes. */
  flushCurrentSnapshot(): Promise<void> {
    return this.schedule(async () => {
      for (let attempt = 0; attempt < 4; attempt++) if (await this.engine.push()) return
      throw new Error("Board is still changing. File backup will retry.")
    })
  }

  private async snapshotRevision(): Promise<string | undefined> {
    try {
      const revision = await this.store.readSnapshotRevision?.(this.config.workspaceId)
      const attachments = await this.store.readAttachmentRevision?.(this.config.workspaceId)
      const history = await this.store.readHistoryRevision?.(this.config.workspaceId)
      return revision !== undefined && attachments !== undefined && history !== undefined
        ? canonicalizeJson([revision, attachments, history])
        : revision !== undefined && attachments !== undefined ? canonicalizeJson([revision, attachments]) : revision
    }
    catch (error) {
      this.observe("mesh.rusty.revision.failed", { phase: "revision", errorCode: "snapshot_revision_unavailable", error })
      return undefined
    }
  }

  private async captureSnapshot() {
    const { snapshot, plaintext, hash } = await this.snapshot()
    this.capturedParts = hash === this.capturedHash && this.capturedParts ? this.capturedParts : await this.parts(snapshot)
    this.capturedHash = hash
    this.freshUpload = true
    return { hash, bytes: plaintext.length, payload: plaintext, identity: this.contentIdentity(this.capturedParts) }
  }

  private contentIdentity(parts: ContentParts): string {
    const values = [parts.revision ?? parts.document, parts.authority, parts.chat]
    if (parts.attachments !== undefined) values.push(parts.attachments)
    if (parts.history !== undefined) values.push(parts.history)
    return canonicalizeJson(values)
  }

  private async receiveSnapshot(object: BlindObject) {
    const plaintext = await this.phase("decrypt", () => openWithReplicaContentKeys(this.config, object.keyEpoch,
      key => decryptBlindObject(object, this.config.scopeId, object.keyEpoch, decodeBlindBytes(key))))
    if (plaintext.length > maximumPlaintextBytes) throw new Error("Encrypted snapshot exceeds client limit")
    const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as Snapshot
    if (snapshot.workspaceId !== this.config.workspaceId || typeof snapshot.document !== "string" || !snapshot.authorization ||
        snapshot.version !== (snapshot.history === undefined ? 1 : 2)) {
      throw new Error("Encrypted snapshot does not match this workspace")
    }
    const attachments = await readAttachmentLocators(snapshot.attachments)
    if (attachments.length && !this.store.mergeAttachments) throw new Error("Attachment index reader upgrade required")
    const document = decodeBlindBytes(snapshot.document)
    if (snapshot.history !== undefined) {
      if (!this.store.receiveHistoryBaseline) throw new Error("History baseline reader upgrade required")
      await this.phase("history-admission", () => this.store.receiveHistoryBaseline!(this.config.workspaceId, document, snapshot.authorization, structuredClone(snapshot.history)))
    } else {
      await this.phase("admission-merge", () => this.store.merge(this.config.workspaceId, document, snapshot.authorization))
    }
    if (snapshot.chat != null) await this.phase("chat-merge", () => this.store.mergeChat(this.config.workspaceId, snapshot.chat))
    if (attachments.length) await this.store.mergeAttachments!(this.config.workspaceId, attachments)
    this.receivedHash = await blindHash(new TextEncoder().encode(canonicalizeJson(snapshot)))
    this.receivedParts = await this.parts(snapshot)
    return { hash: this.receivedHash, identity: this.contentIdentity(this.receivedParts) }
  }

  private async upload(object: BlindObject, requestId: string, observedSequence: number): Promise<BlindReceipt> {
    const changedFields = changedParts(this.capturedParts ?? this.previousParts ?? this.receivedParts ?? { document: "", authority: "", chat: "" }, this.previousParts ?? this.receivedParts)
    const phase = uploadPhase(!this.freshUpload, this.previousParts !== undefined || this.receivedParts !== undefined)
    this.freshUpload = false
    this.observe("mesh.rusty.upload.started", { phase, changedFields })
    try { return await this.transport.upload({ ...this.config }, object, requestId, observedSequence) }
    catch (error) { this.observe("mesh.rusty.upload.failed", { phase: "delivery", error }); throw error }
  }

  private observeProgress(detail: Record<string, unknown>) {
    const changedFields = this.capturedParts ? changedParts(this.capturedParts, this.previousParts ?? this.receivedParts) : []
    if (detail.phase === "uploaded") {
      this.previousParts = this.capturedParts ?? this.previousParts
      this.observe("mesh.rusty.upload.completed", { phase: "changed", changedFields, bytes: detail.bytes })
    } else {
      const phase = changedFields.length === 1 && changedFields[0] === "encoding" ? "encoding_unchanged_state"
        : detail.phase === "already-stored" && this.capturedHash === this.receivedHash ? "remote_already_stored" : "unchanged"
      this.observe("mesh.rusty.upload.skipped", { phase, bytes: detail.bytes })
      if (detail.phase === "already-stored") this.previousParts = this.capturedParts
    }
    this.freshUpload = false
  }

  private async snapshot(document?: Uint8Array, historyOverride?: unknown) {
    const bytes = document ?? await this.store.read(this.config.workspaceId)
    const snapshot: Snapshot = { version: 1, workspaceId: this.config.workspaceId, document: encodeBlindBytes(bytes),
      authorization: await this.store.authorization(bytes, this.config.workspaceId), chat: await this.store.readChat(this.config.workspaceId) }
    const history = historyOverride ?? await this.store.readHistoryBaseline?.(this.config.workspaceId)
    if (history !== undefined) {
      snapshot.history = (await import("../product-replica/historyBaselineReceiver")).parseWireHistoryBaseline(history)
      snapshot.version = 2
    }
    const attachments = await readAttachmentLocators(await this.store.readAttachments?.(this.config.workspaceId))
    if (attachments.length) snapshot.attachments = attachments
    const plaintext = new TextEncoder().encode(canonicalizeJson(snapshot))
    if (plaintext.length > maximumPlaintextBytes) throw new Error("Workspace snapshot exceeds Rusty object limit")
    return { bytes, snapshot, plaintext, hash: await blindHash(plaintext) }
  }

  private checkpointAvailable(): boolean {
    return !!(this.store.prepareCheckpoint && this.store.checkpointAllowed && this.transport.checkpoint &&
      (this.checkpointPending || this.retainedObjects >= 8))
  }

  private async prepareCheckpointState(): Promise<boolean> {
    if ((await this.readProgress()).pending) return false
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
      this.observe("mesh.rusty.checkpoint.failed", { phase: "delivery", bytes: pending.bytes, error })
      throw error
    }
    const progress = await this.readProgress()
    if (progress.pending) throw new Error("Pending Rusty upload must complete before checkpoint activation")
    await this.persistProgress(progress.generation, { ...progress, generation: progress.generation + 1,
      cursor: Math.max(progress.cursor, sequence), lastUploaded: pending.hash, uploadedRevision: undefined,
      contentIdentity: this.contentIdentity(pending.parts) })
    this.previousParts = pending.parts
    this.checkpointPending = undefined
    this.retainedObjects = 1
    this.observe("mesh.rusty.checkpoint.completed", { phase: "replacement", bytes: pending.bytes })
    return "completed"
  }

  private async parts(snapshot: Snapshot): Promise<ContentParts> {
    const [document, authority, chat, revision, history] = await Promise.all([
      blindHash(new TextEncoder().encode(snapshot.document)),
      blindHash(new TextEncoder().encode(canonicalizeJson(snapshot.authorization))),
      blindHash(new TextEncoder().encode(canonicalizeJson(snapshot.chat))),
      this.documentRevision(decodeBlindBytes(snapshot.document)),
      snapshot.history === undefined ? Promise.resolve(undefined) :
        blindHash(new TextEncoder().encode(canonicalizeJson(snapshot.history))),
    ])
    const attachments = snapshot.attachments?.length ? await blindHash(new TextEncoder().encode(canonicalizeJson(snapshot.attachments))) : undefined
    return { document, authority, chat, ...(revision !== undefined ? { revision } : {}), ...(attachments !== undefined ? { attachments } : {}),
      ...(history !== undefined ? { history } : {}) }
  }

  private async documentRevision(bytes: Uint8Array): Promise<string | undefined> {
    try { return await this.store.documentRevision?.(bytes) }
    catch (error) {
      const errorCode = error instanceof RangeError ? "revision_invalid_document" : error instanceof TypeError ? "revision_invalid_type" : "revision_unavailable"
      this.observe("mesh.rusty.revision.failed", { phase: "revision", errorCode, error })
      return undefined
    }
  }

  private observe(event: string, detail: Record<string, unknown>) {
    try { this.store.diagnostic?.(event, { workspaceId: this.config.workspaceId, entityType: "scope", entityId: this.config.scopeId, component: "rusty", operation: event.includes("checkpoint") ? "checkpoint" : event.includes("revision") ? "revision" : "upload", ...detail }) }
    catch { /* Diagnostic failures must not affect durable replication. */ }
  }

  private phase<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      try { return await operation() }
      catch (error) { this.observe(`mesh.rusty.${name}.failed`, { phase: name, operation: name, error }); throw error }
    }
    return this.store.operation ? this.store.operation(`rusty.${name}`, run) : run()
  }

  sync(): Promise<boolean> {
    return this.schedule(async () => {
      const caughtUp = await this.pullNow()
      await this.store.prepareAttachments?.()
      if (caughtUp) {
        const result = await this.checkpoint()
        if (result === "conflict") return false
        if (result === "completed") return true
      }
      const uploaded = await this.engine.push()
      return caughtUp && uploaded
    })
  }
}
