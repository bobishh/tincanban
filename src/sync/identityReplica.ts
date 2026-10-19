import { ReplicaEngine, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import type { IdentityReplicaConfig } from "./blindReplication"
import { encryptPurposeBoundObject, decryptPurposeBoundObject, decodeBlindBytes, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { blindHash, canonicalBlindJson, inventoryBlindObjects, downloadBlindObject, uploadBlindObject,
  verifyBlindReceipt, type BlindReceipt, type BlindAccess } from "./blindClient"
import { readIdentityReplicaRecord, type IdentityReplicaRecord } from "./identityReplicaProtocol"
import { openWithReplicaContentKeys } from "./replicaContentKeys"

type Transfer = Awaited<ReturnType<typeof readIdentityReplicaRecord>>["transfer"]
export type IdentityReplicaStore = {
  repository: { read: () => Promise<ReplicaState<BlindObject>>; commit: (generation: number, next: ReplicaState<BlindObject>) => Promise<void> }
  revision: () => Promise<string>
  capture: () => Promise<IdentityReplicaRecord>
  merge: (transfer: Transfer) => Promise<void>
  authorize: (deviceId: string, managementRevision: number) => Promise<void>
  guard: () => Promise<void>
  runExclusive?: <T>(operation: () => Promise<T>) => Promise<T>
}
type Transport = { inventory: typeof inventoryBlindObjects; download: typeof downloadBlindObject;
  upload: (access: BlindAccess, object: BlindObject, requestId: string) => Promise<BlindReceipt> }
const encoder = new TextEncoder()

/** Private identity state has its own content adapter. Cursor/outbox/receipt behavior stays in the shared engine. */
export class IdentityReplica {
  private readonly engine: ReplicaEngine<Uint8Array, BlindObject, BlindReceipt>

  constructor(config: IdentityReplicaConfig, binding: string, private readonly store: IdentityReplicaStore,
    transport: Transport = { inventory: inventoryBlindObjects, download: downloadBlindObject, upload: uploadBlindObject }) {
    config = structuredClone(config)
    const cryptoBinding = { purpose: "identity-state" as const, subjectId: config.personId, scopeId: config.scopeId, keyEpoch: config.keyEpoch }
    const contentKey = decodeBlindBytes(config.contentKey)
    const identity = async (record: IdentityReplicaRecord) => blindHash(encoder.encode(canonicalBlindJson([
      record.payload.personId, record.payload.origin, record.payload.serviceId, record.payload.scopeId, record.payload.keyEpoch,
      record.payload.managementRevision, record.payload.state,
    ])))
    this.engine = new ReplicaEngine(binding, {
      repository: store.repository,
      content: { revision: store.revision, capture: async () => {
        const record = await store.capture()
        await readIdentityReplicaRecord(record, config, store.authorize)
        const payload = encoder.encode(canonicalBlindJson(record))
        return { payload, bytes: payload.length, hash: await blindHash(payload), identity: await identity(record) }
      }, seal: payload => encryptPurposeBoundObject(cryptoBinding, contentKey, payload) },
      transport: { inventory: cursor => transport.inventory(config, cursor), download: id => transport.download(config, id),
        upload: (object, requestId) => transport.upload(config, object, requestId) },
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
    })
  }

  private run<T>(operation: () => Promise<T>): Promise<T> { return this.store.runExclusive ? this.store.runExclusive(operation) : operation() }
  pull(): Promise<boolean> { return this.run(() => this.engine.pull()) }
  push(): Promise<boolean> { return this.run(() => this.engine.push()) }
  drainPending(): Promise<boolean> { return this.run(() => this.engine.drainPending()) }
  sync(): Promise<boolean> { return this.run(() => this.engine.sync()) }
}
