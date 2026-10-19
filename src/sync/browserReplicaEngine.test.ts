import { expect, test, vi } from "vitest"
import { emptyReplicaState, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { blindHash, canonicalBlindJson, type BlindAccess, type BlindReceipt } from "./blindClient"
import { BlindReplica, type BlindReplicaConfig } from "./blindReplication"
import { encodeBlindBytes, uploadRustyObject, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { withPrivateReplicaOperation } from "./privateReplicaOperation"
import { getPrivateReplicaProgress, getReplicaConfigurations, privateReplicaBinding, persistPrivateReplicaState,
  setReplicaPreference } from "./privateReplicaRepository"
import { runReplicaHostContractVectors, type ReplicaHostContractVector, type ReplicaHostPending,
  type ReplicaHostVectorObservation } from "./replicaHostContractVectors.testSupport"

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

async function runBrowserReplicaHostVector(vector: ReplicaHostContractVector): Promise<ReplicaHostVectorObservation> {
  const authority = await createReceiptAuthority()
  const localToken = encodeBlindBytes(new Uint8Array(32).fill(1))
  const config: BlindReplicaConfig = {
    origin: "https://rusty.example", scopeId: localToken, servicePublicKey: authority.servicePublicKey,
    readToken: localToken, writeToken: encodeBlindBytes(new Uint8Array(32).fill(2)), policyRevision: 1, keyEpoch: 1,
    contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), workspaceId: "workspace-a", cursor: 0, lastUploaded: "",
  }
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, config)
  const selected = (await getReplicaConfigurations(owner))[0]
  if (!selected) throw new Error("Browser replica preference missing")
  let loseFirstResponse = vector === "response-loss-restart"
  let failAckCas = vector === "failed-ack-cas"
  const uploads: ReplicaHostPending[] = []
  let pendingAtUpload: ReplicaHostPending | undefined
  let failure: unknown
  const beforeProgress = await getPrivateReplicaProgress(owner, selected)
  const acknowledgementBefore = { cursor: beforeProgress.cursor, lastUploaded: beforeProgress.lastUploaded }
  const store = {
    replicaBinding: privateReplicaBinding(owner, selected),
    runExclusive: <T>(operation: () => Promise<T>) => withPrivateReplicaOperation(owner, selected, operation),
    readReplicaProgress: async () => getPrivateReplicaProgress(owner, selected),
    persistReplicaProgress: async (expected: number, next: ReplicaState<BlindObject>) => {
      const current = await getPrivateReplicaProgress(owner, selected)
      if (failAckCas && current.pending && !next.pending) {
        failAckCas = false
        await persistPrivateReplicaState(owner, selected, expected, { ...current, generation: current.generation + 1 })
      }
      await persistPrivateReplicaState(owner, selected, expected, next)
    },
    read: async () => new Uint8Array([1, 2, 3]),
    authorization: async () => ({ signed: true }),
    merge: async () => {},
    readChat: async () => null,
    mergeChat: async () => {},
    persist: async () => {},
    readSnapshotRevision: async () => "workspace-revision-1",
  }
  const transport = {
    inventory: async (_access: BlindAccess, cursor: number) => ({ objects: [], cursor, hasMore: false }),
    download: async () => { throw new Error("Unexpected download") },
    upload: async (access: BlindAccess, object: BlindObject, requestId: string): Promise<BlindReceipt> => {
      const upload = { object: structuredClone(object), requestId }
      const durable = await getPrivateReplicaProgress(owner, selected)
      pendingAtUpload ??= durable.pending && { object: structuredClone(durable.pending.object), requestId: durable.pending.requestId }
      uploads.push(upload)
      if (loseFirstResponse) { loseFirstResponse = false; throw new Error("Response lost after durable save") }
      if (vector === "revoked-credential") return uploadRustyObject(access, object, requestId, 0,
        async () => Response.json({ message: "Scope credential revoked" }, { status: 403 }))
      if (vector === "wrong-signed-receipt") return signedReceipt(authority, access, object, `${requestId}-wrong`)
      return signedReceipt(authority, access, object, requestId)
    },
  }
  const makeReplica = () => new BlindReplica(selected, store, transport)
  const initial = makeReplica()
  let retryUpload: ReplicaHostPending | undefined
  if (vector === "response-loss-restart") {
    try { await initial.push() } catch (error) { failure = error }
    const afterLoss = (await getPrivateReplicaProgress(owner, selected)).pending
    expect(afterLoss).toBeDefined()
    await makeReplica().push()
    const retry = uploads[1]
    if (retry) retryUpload = retry
  } else {
    try { await initial.push() } catch (error) { failure = error }
  }
  const after = await getPrivateReplicaProgress(owner, selected)
  return {
    pendingAtUpload,
    upload: uploads[0]!,
    pendingAfter: after.pending ? { object: structuredClone(after.pending.object), requestId: after.pending.requestId } : undefined,
    acknowledgementBefore,
    acknowledgementAfter: { cursor: after.cursor, lastUploaded: after.lastUploaded },
    uploadCount: uploads.length,
    ...(retryUpload ? { retryUpload } : {}),
    ...(failure === undefined ? {} : { failure }),
  }
}

test("Given the shared replica contract vectors, when the browser host adapter runs, then preserve exact pending and acknowledgement invariants", async () => {
  await runReplicaHostContractVectors(runBrowserReplicaHostVector)
})

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
