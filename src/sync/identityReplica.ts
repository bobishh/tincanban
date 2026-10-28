import { ReplicaEngine, emptyReplicaState, type ReplicaPorts, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import type { IdentityReplicaConfig } from "./blindReplication"
import { encryptPurposeBoundObject, decryptPurposeBoundObject, decodeBlindBytes, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { blindHash, canonicalBlindJson, inventoryBlindObjects, downloadBlindObject, uploadBlindObject,
  verifyBlindReceipt, type BlindReceipt, type BlindAccess } from "./blindClient"
import { readIdentityReplicaRecord, type IdentityReplicaRecord } from "./identityReplicaProtocol"
import { openWithReplicaContentKeys } from "./replicaContentKeys"
import { pushWithCheckpointRefresh, uploadWithCheckpointEvidence } from "./rustyCheckpointRecovery"
import type { BlindCheckpointRequest, BlindCheckpointReceipt } from "./blindCheckpoint"

type Transfer = Awaited<ReturnType<typeof readIdentityReplicaRecord>>["transfer"]
export type IdentityReplicaStore = {
  repository: { read: () => Promise<ReplicaState<BlindObject>>; commit: (generation: number, next: ReplicaState<BlindObject>) => Promise<void> }
  revision: () => Promise<string>
  capture: () => Promise<IdentityReplicaRecord>
  merge: (transfer: Transfer) => Promise<void>
  authorize: (deviceId: string, managementRevision: number) => Promise<void>
  guard: () => Promise<void>
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>
  prepareCheckpoint?: (object: BlindObject, expectedSequence: number) => Promise<BlindCheckpointRequest>
}
type Transport = { inventory: typeof inventoryBlindObjects; download: typeof downloadBlindObject;
  upload: (access: BlindAccess, object: BlindObject, requestId: string, observedSequence?: number) => Promise<BlindReceipt>
  checkpoint?: (access: BlindAccess, request: BlindCheckpointRequest) => Promise<BlindCheckpointReceipt> }
const encoder = new TextEncoder()

/** Private identity state has its own content adapter. Cursor/outbox/receipt behavior stays in the shared engine. */
export class IdentityReplica {
  private engine: ReplicaEngine<Uint8Array, BlindObject, BlindReceipt>
  private readonly restartEngine: () => void
  private readonly maintainSnapshots: () => Promise<boolean>
  private checkpointPending?: BlindCheckpointRequest
  private checkpointVerification?: ReplicaEngine<Uint8Array, BlindObject, BlindReceipt>
  private operations: Promise<unknown> = Promise.resolve()

  constructor(config: IdentityReplicaConfig, binding: string, private readonly store: IdentityReplicaStore,
    transport: Transport = { inventory: inventoryBlindObjects, download: downloadBlindObject, upload: uploadBlindObject }) {
    config = structuredClone(config)
    const cryptoBinding = { purpose: "identity-state" as const, subjectId: config.personId, scopeId: config.scopeId, keyEpoch: config.keyEpoch }
    const contentKey = decodeBlindBytes(config.contentKey)
    const identity = async (record: IdentityReplicaRecord) => blindHash(encoder.encode(canonicalBlindJson([
      record.payload.personId, record.payload.origin, record.payload.serviceId, record.payload.scopeId, record.payload.keyEpoch,
      record.payload.managementRevision, record.payload.state,
    ])))
    const ports: ReplicaPorts<Uint8Array, BlindObject, BlindReceipt> = {
      repository: store.repository,
      content: { revision: store.revision, capture: async () => {
        const record = await store.capture()
        await readIdentityReplicaRecord(record, config, store.authorize)
        const payload = encoder.encode(canonicalBlindJson(record))
        return { payload, bytes: payload.length, hash: await blindHash(payload), identity: await identity(record) }
      }, seal: payload => encryptPurposeBoundObject(cryptoBinding, contentKey, payload) },
      transport: { inventory: cursor => transport.inventory(config, cursor), download: id => transport.download(config, id),
        upload: (object, requestId, observedSequence) => uploadWithCheckpointEvidence({ object, requestId, observedSequence },
          () => transport.upload(config, object, requestId, observedSequence)) },
      admit: async object => {
        const bytes = await openWithReplicaContentKeys(config, object.keyEpoch,
          key => decryptPurposeBoundObject(object, { ...cryptoBinding, keyEpoch: object.keyEpoch }, decodeBlindBytes(key)))
        const parsed = await readIdentityReplicaRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          { ...config, keyEpoch: object.keyEpoch }, store.authorize)
        await store.guard()
        await store.merge(parsed.transfer)
        await store.guard()
        return { hash: await blindHash(bytes), identity: await identity(parsed.record) }
      },
      verifyReceipt: (receipt, object, requestId) => verifyBlindReceipt(receipt, config, object, requestId), guard: store.guard,
    }
    this.engine = new ReplicaEngine(binding, ports)
    this.restartEngine = () => { this.engine = new ReplicaEngine(binding, ports) }
    const verifySnapshots = async (): Promise<number | undefined> => {
      // Ordinary catalog pulls can omit recovery evidence while advancing the shared cursor.
      // A fresh full-content replay must complete before any stored object is replaced.
      if (!this.checkpointVerification) {
        let verified = emptyReplicaState<BlindObject>(binding)
        this.checkpointVerification = new ReplicaEngine(binding, { ...ports, repository: {
          read: async () => structuredClone(verified),
          commit: async (expected, next) => {
            if (verified.generation !== expected) throw new Error("Identity checkpoint verification changed")
            verified = structuredClone(next)
          },
        } })
      }
      if (!await this.checkpointVerification.pull()) return undefined
      const inventory = this.checkpointVerification.inventoryStatus()!
      return inventory.maxSequence ?? inventory.cursor
    }
    this.maintainSnapshots = async () => {
      if (!store.prepareCheckpoint || !transport.checkpoint) return true
      if (!await this.engine.pull()) return false
      const inventory = this.engine.inventoryStatus()!
      if (this.checkpointPending && this.checkpointPending.authorization.payload.expiresAt <= Date.now()) {
        this.checkpointPending = undefined
      }
      if (!this.checkpointPending && (inventory.objectCount ?? 0) < 8) return true
      await store.guard()
      if (!this.checkpointPending) {
        const verifiedSequence = await verifySnapshots()
        if (verifiedSequence === undefined) return false
        const captured = await ports.content.capture()
        const object = await ports.content.seal(captured.payload)
        await store.guard()
        this.checkpointPending = await store.prepareCheckpoint(object, verifiedSequence)
        this.checkpointVerification = undefined
      }
      try { await transport.checkpoint(config, this.checkpointPending) }
      catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "checkpoint_conflict") {
          this.checkpointPending = undefined
          return false
        }
        throw cause
      }
      await store.guard()
      this.checkpointPending = undefined
      // Preserve any uncertain original upload. Its normal receipt/rejection path owns the outbox.
      return this.engine.pull()
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const exclusive = () => this.store.runExclusive ? this.store.runExclusive(operation) : operation()
    const next = this.operations.then(exclusive, exclusive)
    this.operations = next.then(() => undefined, () => undefined)
    return next
  }
  private pushNow(operation = () => this.engine.push()): Promise<boolean> {
    return pushWithCheckpointRefresh({ guard: this.store.guard, read: this.store.repository.read,
      commit: this.store.repository.commit, pull: () => this.engine.pull(), push: () => this.engine.push(),
      restart: this.restartEngine }, operation)
  }
  pull(): Promise<boolean> { return this.run(() => this.engine.pull()) }
  push(): Promise<boolean> { return this.run(() => this.pushNow()) }
  drainPending(): Promise<boolean> { return this.run(() => this.engine.drainPending()) }
  sync(): Promise<boolean> { return this.run(async () => {
    if (!await this.maintainSnapshots()) return false
    return this.pushNow(() => this.engine.sync())
  }) }
}
