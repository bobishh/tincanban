import { emptyReplicaState, type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { BlindReplica, type BlindReplicaConfig } from "../../src/sync/blindReplication"
import { blindHash, canonicalBlindJson, type BlindReceipt } from "../../src/sync/blindClient"
import { encodeBlindBytes, type BlindObject } from "../../src/sync/blindEnvelope"
import { withPrivateReplicaOperation } from "../../src/sync/privateReplicaOperation"

type Fixture = { owner: string; config: BlindReplicaConfig; signer: JsonWebKey; serviceId: string; key: string }
type Saved = { progress: ReplicaState<BlindObject>; uploads: Array<{ object: BlindObject; requestId: string }> }

export async function prepare(): Promise<Fixture> {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  const owner = crypto.randomUUID()
  const config: BlindReplicaConfig = { origin: "https://rusty.example", scopeId: crypto.randomUUID(), workspaceId: "fixture-board",
    servicePublicKey: encodeBlindBytes(publicKey), readToken: "read", writeToken: "write", policyRevision: 1, keyEpoch: 1,
    contentKey: encodeBlindBytes(crypto.getRandomValues(new Uint8Array(32))), cursor: 0, lastUploaded: "" }
  const key = `replica-concurrency:${owner}`
  localStorage.setItem(key, JSON.stringify({ progress: emptyReplicaState(key), uploads: [] }))
  return { owner, config, key, signer: await crypto.subtle.exportKey("jwk", pair.privateKey), serviceId: await blindHash(publicKey) }
}

export function inspect(fixture: Fixture): Saved { return JSON.parse(localStorage.getItem(fixture.key)!) as Saved }

export async function push(fixture: Fixture, loseResponse = false): Promise<string> {
  localStorage.setItem(`${fixture.key}:attempt:${crypto.randomUUID()}`, "started")
  const { config } = fixture
  const signer = await crypto.subtle.importKey("jwk", fixture.signer, "Ed25519", false, ["sign"])
  const replica = new BlindReplica(config, {
    replicaBinding: fixture.key,
    runExclusive: run => withPrivateReplicaOperation(fixture.owner, config, run),
    readReplicaProgress: async () => inspect(fixture).progress,
    persistReplicaProgress: async (expected, next) => {
      const saved = inspect(fixture)
      if (saved.progress.generation !== expected) throw new Error("Replica progress generation changed during persistence")
      localStorage.setItem(fixture.key, JSON.stringify({ ...saved, progress: next }))
    },
    read: async () => new Uint8Array([1]), authorization: async () => ({}),
    readSnapshotRevision: async () => "unchanged-board", readChat: async () => null,
    merge: async () => {}, mergeChat: async () => {}, persist: async () => {},
  }, {
    inventory: async (_access, cursor) => ({ objects: [], cursor, hasMore: false }),
    download: async () => { throw new Error("Unexpected download") },
    upload: async (_access, object, requestId): Promise<BlindReceipt> => {
      const saved = inspect(fixture)
      saved.uploads.push({ object, requestId })
      localStorage.setItem(fixture.key, JSON.stringify(saved))
      if (loseResponse) throw new Error("Response lost after remote save")
      // Both tabs enter push before the saved request is acknowledged.
      const deadline = Date.now() + 5_000
      while (Object.keys(localStorage).filter(key => key.startsWith(`${fixture.key}:attempt:`)).length < 3) {
        if (Date.now() > deadline) throw new Error("Second tab did not start its retry")
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      await new Promise(resolve => setTimeout(resolve, 50))
      const payload = { kind: "blind-storage-receipt" as const, version: 2 as const, serviceId: fixture.serviceId,
        scopeId: config.scopeId, keyEpoch: object.keyEpoch, objectId: await blindHash(new TextEncoder().encode(canonicalBlindJson(object))),
        sequence: 1, policyRevision: config.policyRevision, requestId }
      const signature = await crypto.subtle.sign("Ed25519", signer,
        new TextEncoder().encode(`RUSTY/2/${payload.kind}\0${canonicalBlindJson(payload)}`))
      return { payload, signerKeyId: fixture.serviceId, signature: encodeBlindBytes(new Uint8Array(signature)) }
    },
  })
  try { await replica.push(); return "acknowledged" }
  catch (error) { return error instanceof Error ? error.message : String(error) }
}
