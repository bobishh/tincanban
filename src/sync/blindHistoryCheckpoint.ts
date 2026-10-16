import { canonicalizeJson, sha256Base64Url } from "../domain/identity"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { privateReplicaBinding, readReplicaWriterUpgrade } from "./privateReplicaRepository"
import { blindHash, discoverBlindKeeper } from "./blindClient"
import { decodeBlindBytes, decryptBlindObject, encryptBlindObject } from "./blindEnvelope"
import { verifyCheckpointReceipt, type BlindCheckpointReceipt, type BlindCheckpointRequest } from "./blindCheckpoint"
import type { BlindReplicaConfig } from "./blindReplication"

export class HistoryStorageCheckpointConflictError extends Error {
  constructor(readonly baselineId: string, cause: Error) { super("Another device saved new changes during history capture. Sync and retry to archive them before replacing Rusty snapshots.", { cause }); this.name = "HistoryStorageCheckpointConflictError" }
}

type Journal = { version: 1; binding: string; expectedSequence: number; baselineId?: string;
  request?: BlindCheckpointRequest; receipt?: BlindCheckpointReceipt; hash?: string }
const encoder = new TextEncoder()
async function location(owner: string, config: BlindReplicaConfig, transitionId: string) {
  if (!transitionId || transitionId.length > 128) throw new Error("Invalid history checkpoint transition")
  const binding = await sha256Base64Url(encoder.encode(privateReplicaBinding(owner, config)))
  return { binding, key: `tincanban.history-checkpoint.v1.${await sha256Base64Url(encoder.encode(canonicalizeJson([binding, transitionId])))}` }
}
function parse(raw: string, binding: string): Journal {
  if (raw.length > 32 * 1024 * 1024) throw new Error("Saved history checkpoint exceeds its byte bound")
  const value = JSON.parse(raw) as Journal
  if (!value || value.version !== 1 || value.binding !== binding || !Number.isSafeInteger(value.expectedSequence) || value.expectedSequence < 0 ||
      Object.keys(value).some(key => !["version", "binding", "expectedSequence", "baselineId", "request", "receipt", "hash"].includes(key)) ||
      value.request && (!value.baselineId || !value.hash || value.request.authorization?.payload.expectedSequence !== value.expectedSequence) ||
      value.receipt && !value.request) throw new Error("Saved history checkpoint binding is invalid")
  return value
}
async function save(key: string, previous: string | null, next: Journal, guard: () => void): Promise<string> {
  const raw = canonicalizeJson(next)
  parse(raw, next.binding)
  if (!await compareAndSwapLocal({ conditions: [{ key, value: previous }], writes: [{ key, value: raw }] }, guard)) {
    throw new Error("History checkpoint changed concurrently; retry original transition")
  }
  guard()
  return raw
}

/** Record the drained snapshot fence before archive capture; retries never silently widen it. */
export async function recordHistoryStorageFence(owner: string, config: BlindReplicaConfig, transitionId: string,
  sequence: number, guard: () => void): Promise<void> {
  guard()
  const { key, binding } = await location(owner, config, transitionId)
  const raw = await readLocal(key)
  guard()
  if (raw !== null) { parse(raw, binding); return }
  await save(key, null, { version: 1, binding, expectedSequence: sequence }, guard)
}

type Ports = {
  guard(): void
  ensureCurrent(): Promise<void>
  capture(): Promise<{ bytes: Uint8Array; plaintext: Uint8Array; hash: string }>
  prepare(bytes: Uint8Array, object: BlindCheckpointRequest["object"], sequence: number,
    baselineId: string, existing?: BlindCheckpointRequest): Promise<BlindCheckpointRequest>
  submit(request: BlindCheckpointRequest): Promise<BlindCheckpointReceipt>
}
/** Exact signed replacement and ciphertext survive interruption independently of in-memory replica state. */
export async function publishHistoryStorageCheckpoint(owner: string, config: BlindReplicaConfig, transitionId: string,
  baselineId: string, ports: Ports): Promise<{ sequence: number; hash: string }> {
  ports.guard()
  if (await readReplicaWriterUpgrade(owner, config)) throw new Error("Finish automation storage maintenance before replacing Rusty history")
  await ports.ensureCurrent()
  const { key, binding } = await location(owner, config, transitionId)
  let raw = await readLocal(key)
  if (raw === null) throw new Error("History checkpoint has no original drained storage fence")
  let state = parse(raw, binding)
  if (state.baselineId && state.baselineId !== baselineId) throw new Error("History checkpoint names another compact basis")
  let request = state.request
  if (!request) {
    const snapshot = await ports.capture()
    ports.guard()
    const object = await encryptBlindObject(config.scopeId, config.keyEpoch, decodeBlindBytes(config.contentKey), snapshot.plaintext)
    request = await ports.prepare(snapshot.bytes, object, state.expectedSequence, baselineId)
    state = { ...state, baselineId, request, hash: snapshot.hash }
    raw = await save(key, raw, state, ports.guard)
  } else {
    const plaintext = await decryptBlindObject(request.object, config.scopeId, config.keyEpoch, decodeBlindBytes(config.contentKey))
    const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as { document: string }
    if (await blindHash(plaintext) !== state.hash) throw new Error("Saved history checkpoint ciphertext changed")
    const validated = await ports.prepare(decodeBlindBytes(snapshot.document), request.object, state.expectedSequence, baselineId, request)
    if (canonicalizeJson(validated) !== canonicalizeJson(request)) {
      throw new Error("Preserve the exact original history checkpoint authorization while delivery is uncertain")
    }
  }
  ports.guard()
  await ports.ensureCurrent()
  if (await readReplicaWriterUpgrade(owner, config)) throw new Error("Finish automation storage maintenance before replacing Rusty history")
  const receipt = state.receipt ?? await ports.submit(request).catch(cause => {
    if (cause instanceof Error && "code" in cause && cause.code === "checkpoint_conflict" && "status" in cause && cause.status === 409) {
      throw new HistoryStorageCheckpointConflictError(baselineId, cause)
    }
    throw cause
  })
  await verifyCheckpointReceipt(receipt, config, request)
  await ports.ensureCurrent()
  ports.guard()
  if (!state.receipt) await save(key, raw, { ...state, receipt }, ports.guard)
  return { sequence: receipt.payload.sequence, hash: state.hash! }
}

/** A fresh attempt is safe only before any signed delivery request was durably prepared. */
export async function historyCheckpointDeliveryPrepared(owner: string, config: BlindReplicaConfig, transitionId: string,
  guard: () => void): Promise<boolean> {
  const { key, binding } = await location(owner, config, transitionId), raw = await readLocal(key)
  guard()
  if (raw === null) throw new Error("Original history checkpoint fence is unavailable")
  return Boolean(parse(raw, binding).request)
}

/** Old storage remains usable for ordinary sync; compaction requires the ordering fence before any maintenance mutation. */
export async function assertHistoryStorageCheckpointSupport(config: BlindReplicaConfig, guard: () => void | Promise<void>): Promise<void> {
  const service = await discoverBlindKeeper(config.origin)
  await guard()
  if (service.servicePublicKey !== config.servicePublicKey) throw new Error("Rusty service identity changed before history capture")
  if (service.snapshotCheckpoints !== 1 || service.snapshotWriteFence !== 1) {
    throw new Error("Update Rusty before archiving history: snapshot ordering protection is unavailable")
  }
}
