import { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { load, getHeads, getChangesMetaSince, free } from "@automerge/automerge/slim"
import type { useTincanban } from "../state"
import { defaultStorage } from "../storage"
import { decodeBlindBytes, decryptBlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { canonicalizeJson } from "../domain/identity"
import { parseWireHistoryBaseline } from "../product-replica"
import { createReceivedHistoryBaselineRepository } from "./receivedHistoryBaselineRepository"
import { workspaceRole } from "./changeAuthorization"
import { prepareBlindCheckpoint, type BlindCheckpointRequest } from "./blindCheckpoint"
import type { BlindReplicaConfig } from "./blindReplication"
import { stateRuntime } from "../stateContext"
import { assertWorkspaceWritesAllowed } from "../stateCausalAdmission"

/** Distinct from raw-history pruning: a Native-verified covered compact candidate replaces storage before local activation. */
export async function prepareHistoryBasisCheckpoint(tincanban: ReturnType<typeof useTincanban>, config: BlindReplicaConfig,
  bytes: Uint8Array, object: BlindCheckpointRequest["object"], expectedSequence: number, baselineId: string,
  guard: () => void, existing?: BlindCheckpointRequest, candidate?: WasmVerifiedReceivedHistoryBaseline, history?: unknown): Promise<BlindCheckpointRequest> {
  guard()
  assertCheckpointRuntime(tincanban)
  const profile = tincanban.getCurrentProfile()
  if (!profile) throw new Error("Current history checkpoint identity is unavailable")
  await assertWorkspaceWritesAllowed(config.workspaceId)
  const document = load<{ id: string; ownerPersonId: string }>(bytes)
  try {
    if (document.id !== config.workspaceId || await workspaceRole(document as never, profile) !== "owner") {
      throw new Error("Only the current workspace Owner may checkpoint compact history")
    }
    const basis = candidate ?? await defaultStorage.getVerifiedReceivedHistoryBaseline(config.workspaceId, guard)
    if (!(basis instanceof WasmVerifiedReceivedHistoryBaseline)) throw new Error("History checkpoint requires its Native-verified compact basis")
    const payload = (basis.envelope() as { payload: { baselineId: string } }).payload
    if (payload.baselineId !== baselineId || basis.storageVerification() !== "encrypted-correspondence") {
      throw new Error("History checkpoint requires the exact activated basis and verified archive coverage")
    }
    await assertCheckpointCiphertext(config, object, bytes, basis, guard, history)
    const compact = load(basis.document())
    try {
      if (getChangesMetaSince(document, []).length !== 1 || getHeads(document).sort().join() !== getHeads(compact).sort().join()) {
        throw new Error("History checkpoint snapshot changed after compact basis activation")
      }
    } finally { free(compact) }
    guard()
    // Rusty can confirm an exact accepted authorization after expiry; never replace uncertain delivery evidence.
    if (existing) return existing
    return await prepareBlindCheckpoint(config, object, expectedSequence, profile, { ensureCurrent: guard })
  } finally { free(document) }
}

function assertCheckpointRuntime(tincanban: ReturnType<typeof useTincanban>) {
  if (!stateRuntime.ready.value || stateRuntime.pendingWrites || stateRuntime.batchSaveFailed || stateRuntime.reconcilePromise ||
      stateRuntime.reconcileRequested || tincanban.causalReviewError.value) throw new Error("Wait for workspace writes before history checkpoint")
}

async function assertCheckpointCiphertext(config: BlindReplicaConfig, object: BlindCheckpointRequest["object"], document: Uint8Array,
  basis: WasmVerifiedReceivedHistoryBaseline, guard: () => void, history?: unknown) {
  const key = decodeBlindBytes(config.contentKey)
  let plaintext: Uint8Array
  try { plaintext = await decryptBlindObject(object, config.scopeId, config.keyEpoch, key) }
  finally { key.fill(0) }
  guard()
  const snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as { version: number; workspaceId: string; document: string; history: unknown }
  const bytes = decodeBlindBytes(snapshot.document)
  const wire = parseWireHistoryBaseline(snapshot.history)
  const expected = history ?? (await createReceivedHistoryBaselineRepository(config.workspaceId, guard).readActive())?.wire
  if (!expected || snapshot.version !== 2 || snapshot.workspaceId !== config.workspaceId || bytes.length !== document.length ||
      !bytes.every((value, index) => value === document[index]) || canonicalizeJson(wire) !== canonicalizeJson(parseWireHistoryBaseline(expected)) ||
      canonicalizeJson(JSON.parse(new TextDecoder().decode(decodeBlindBytes(wire.signedJson)))) !==
        canonicalizeJson(JSON.parse(new TextDecoder().decode(basis.originalJson())))) {
    throw new Error("History checkpoint ciphertext differs from its verified compact basis and archive routing")
  }
  guard()
}
