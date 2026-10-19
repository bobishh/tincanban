import { expect, test, vi } from "vitest"
import { emptyReplicaState, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { blindHash, canonicalBlindJson, type BlindAccess, type BlindReceipt } from "./blindClient"
import { BlindReplica, type BlindReplicaConfig } from "./blindReplication"
import { encodeBlindBytes, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { withPrivateReplicaOperation } from "./privateReplicaOperation"

async function createReceiptAuthority() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
  const publicKeyBytes = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const servicePublicKey = encodeBlindBytes(publicKeyBytes)
  return {
    pair,
    servicePublicKey,
    serviceId: await blindHash(publicKeyBytes),
  }
}

async function signedReceipt(authority: Awaited<ReturnType<typeof createReceiptAuthority>>, access: BlindAccess,
  object: BlindObject, requestId: string): Promise<BlindReceipt> {
  const payload = {
    kind: "blind-storage-receipt" as const,
    version: 2 as const,
    serviceId: authority.serviceId,
    scopeId: access.scopeId,
    keyEpoch: object.keyEpoch,
    objectId: await blindHash(new TextEncoder().encode(canonicalBlindJson(object))),
    sequence: 1,
    policyRevision: access.policyRevision,
    requestId,
  }
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", authority.pair.privateKey,
    new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`)))
  return { payload, signerKeyId: authority.serviceId, signature: encodeBlindBytes(signature) }
}

test("Given a lost upload response, when separate browser clients retry concurrently, then serialize passes and reuse exact ciphertext and request ID without rereading or resealing", async () => {
  const authority = await createReceiptAuthority()
  const config: BlindReplicaConfig = {
    origin: "https://rusty.example",
    scopeId: "opaque-scope",
    servicePublicKey: authority.servicePublicKey,
    readToken: "read-token",
    writeToken: "write-token",
    policyRevision: 1,
    keyEpoch: 1,
    contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))),
    workspaceId: "workspace-a",
    cursor: 0,
    lastUploaded: "",
  }
  const replicaBinding = "scope:opaque-scope/epoch:1/identity:device-a"
  let progress: ReplicaState<BlindObject> = emptyReplicaState(replicaBinding)
  const currentBinding = replicaBinding
  let loseFirstResponse = true
  let documentReads = 0
  const pendingVisibleAtUpload: boolean[] = []
  const encryption = vi.spyOn(crypto.subtle, "encrypt")
  const uploads: Array<{ object: BlindObject; requestId: string }> = []
  const access: BlindAccess = config

  const store = {
    replicaBinding,
    runExclusive: <T>(operation: () => Promise<T>) => withPrivateReplicaOperation("owner", config, operation),
    readReplicaProgress: async () => structuredClone(progress),
    persistReplicaProgress: async (expectedGeneration: number, next: ReplicaState<BlindObject>) => {
      if (currentBinding !== replicaBinding || progress.binding !== currentBinding) throw new Error("Replica binding changed")
      if (progress.generation !== expectedGeneration) throw new Error("Replica progress conflict")
      progress = structuredClone({ ...next, generation: expectedGeneration + 1 })
    },
    read: async () => { documentReads += 1; return new Uint8Array([1, 2, 3]) },
    authorization: async () => ({ signed: true }),
    readChat: async () => ({ messages: [] }),
    merge: async () => {},
    mergeChat: async () => {},
    persist: async () => {},
    readSnapshotRevision: async () => "workspace-revision-1",
  }
  const transport = {
    inventory: async (_access: BlindAccess, cursor: number) => ({ objects: [], cursor, hasMore: false }),
    download: async () => { throw new Error("Unexpected download") },
    upload: async (_access: BlindAccess, object: BlindObject, requestId: string): Promise<BlindReceipt> => {
      pendingVisibleAtUpload.push(!!progress.pending && progress.pending.requestId === requestId &&
        canonicalBlindJson(progress.pending.object) === canonicalBlindJson(object))
      uploads.push({ object: structuredClone(object), requestId })
      if (loseFirstResponse) {
        loseFirstResponse = false
        throw new Error("Response lost after remote save")
      }
      return signedReceipt(authority, access, object, requestId)
    },
  }
  const makeReplica = () => new BlindReplica(config, store, transport)
  const encryptCallsBefore = encryption.mock.calls.length
  await expect(makeReplica().push()).rejects.toThrow("Response lost")
  const durablePending = progress.pending
  expect(durablePending).toBeDefined()
  expect(durablePending?.object).toEqual(uploads[0]?.object)
  expect(durablePending?.requestId).toBe(uploads[0]?.requestId)
  const readsBeforeRetry = documentReads
  const encryptCallsAfterFirst = encryption.mock.calls.length

  let encryptCallsAfterRetry: number
  try { await Promise.all([makeReplica().push(), makeReplica().push()]) } finally {
    encryptCallsAfterRetry = encryption.mock.calls.length
    encryption.mockRestore()
  }

  expect(uploads).toHaveLength(2)
  expect(pendingVisibleAtUpload).toEqual([true, true])
  expect(uploads[1]).toEqual(uploads[0])
  expect(documentReads).toBe(readsBeforeRetry)
  expect(encryptCallsAfterRetry).toBe(encryptCallsAfterFirst)
  expect(encryptCallsAfterFirst).toBeGreaterThan(encryptCallsBefore)
  expect(progress.pending).toBeUndefined()
  expect(progress.lastUploaded).toBe(durablePending?.hash)
})

test("Given a previously acknowledged durable revision, when a new browser replica polls, then it skips document history reads", async () => {
  const authority = await createReceiptAuthority()
  const config: BlindReplicaConfig = {
    origin: "https://rusty.example", scopeId: "opaque-scope", servicePublicKey: authority.servicePublicKey,
    readToken: "read-token", writeToken: "write-token", policyRevision: 1, keyEpoch: 1,
    contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "workspace-a", cursor: 0, lastUploaded: "",
  }
  const replicaBinding = "scope:opaque-scope/epoch:1/identity:device-a"
  let progress: ReplicaState<BlindObject> = emptyReplicaState(replicaBinding)
  let reads = 0
  let uploads = 0
  const store = {
    replicaBinding,
    readReplicaProgress: async () => structuredClone(progress),
    persistReplicaProgress: async (expectedGeneration: number, next: ReplicaState<BlindObject>) => {
      if (progress.generation !== expectedGeneration) throw new Error("Replica progress conflict")
      progress = structuredClone({ ...next, generation: expectedGeneration + 1 })
    },
    read: async () => { reads += 1; return new Uint8Array([1]) },
    authorization: async () => ({ signed: true }), readChat: async () => null,
    merge: async () => {}, mergeChat: async () => {}, persist: async () => {},
    readSnapshotRevision: async () => "stable-revision",
  }
  const transport = {
    inventory: async (_access: BlindAccess, cursor: number) => ({ objects: [], cursor, hasMore: false }),
    download: async () => { throw new Error("Unexpected download") },
    upload: async (access: BlindAccess, object: BlindObject, requestId: string) => { uploads += 1; return signedReceipt(authority, access, object, requestId) },
  }
  const makeReplica = () => new BlindReplica(config, store, transport)

  await makeReplica().push()
  const readsAfterInitialUpload = reads
  const uploadsAfterInitialUpload = uploads
  await makeReplica().push()

  expect(readsAfterInitialUpload).toBe(1)
  expect(reads).toBe(readsAfterInitialUpload)
  expect(uploads).toBe(uploadsAfterInitialUpload)
  expect(progress.uploadedRevision).toBe("stable-revision")
})
