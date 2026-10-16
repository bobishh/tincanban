import { load, free, getChangesMetaSince, getHeads } from "@automerge/automerge/slim"
import type { useTincanban } from "../state"
import { stateRuntime } from "../stateContext"
import { defaultStorage } from "../storage"
import { discoverBlindKeeper } from "./blindClient"
import type { BlindReplicaConfig, BlindReplicaStore } from "./blindReplication"
import { assertWorkspaceWritesAllowed } from "../stateCausalAdmission"
import { readReplicaWriterUpgrade } from "./privateReplicaRepository"

/** Fail closed: presentation/dismissal never turns quarantined raw history into safe retention deletion. */
export async function checkpointAdmissionReady(tincanban: ReturnType<typeof useTincanban>, workspaceId: string, bytes?: Uint8Array): Promise<boolean> {
  if (!checkpointRuntimeReady(tincanban)) return false
  const profile = tincanban.getCurrentProfile()
  if (!profile || (await tincanban.readWorkspaceDoc(workspaceId)).ownerPersonId !== profile.identity.personId) return false
  try { await assertWorkspaceWritesAllowed(workspaceId) } catch { return false }
  const evidence = await defaultStorage.loadCausalEvidence(workspaceId)
  if (!evidence || !evidence.decisions.length || evidence.decisions.some(decision => decision.status.type !== "admitted")) return false
  const raw = load<{ id: string; ownerPersonId: string }>(evidence.bytes)
  const snapshot = bytes ? load(bytes) : undefined
  try {
    const admitted = new Set(evidence.decisions.map(decision => decision.hash))
    const history = getChangesMetaSince(raw, [])
    return raw.id === workspaceId && raw.ownerPersonId === profile.identity.personId && history.length === admitted.size &&
      history.every(change => admitted.has(change.hash)) && (!snapshot || getHeads(snapshot).sort().join() === getHeads(raw).sort().join())
  } finally { free(raw); if (snapshot) free(snapshot) }
}

function checkpointRuntimeReady(tincanban: ReturnType<typeof useTincanban>): boolean {
  return stateRuntime.ready.value && !stateRuntime.pendingWrites && !stateRuntime.batchSaveFailed && !stateRuntime.reconcilePromise &&
    !stateRuntime.reconcileRequested && !tincanban.causalReviewError.value
}

export function checkpointHooks(tincanban: ReturnType<typeof useTincanban>, config: BlindReplicaConfig, ensureIdentity: () => void): Pick<BlindReplicaStore, "checkpointAllowed" | "prepareCheckpoint"> {
  return {
    checkpointAllowed: async request => {
      ensureIdentity()
      const profile = tincanban.getCurrentProfile()
      if (request && (request.identity.personId !== profile?.identity.personId || request.deviceId !== profile.device.deviceId)) return false
      if (!profile || await readReplicaWriterUpgrade(profile.identity.personId, config)) return false
      ensureIdentity()
      return checkpointAdmissionReady(tincanban, config.workspaceId)
    },
    prepareCheckpoint: async (bytes, object, expectedSequence) => {
      ensureIdentity()
      if (!await checkpointAdmissionReady(tincanban, config.workspaceId, bytes)) return undefined
      const service = await discoverBlindKeeper(config.origin)
      if (service.servicePublicKey !== config.servicePublicKey) throw new Error("Rusty service identity changed")
      if (service.snapshotCheckpoints !== 1) return undefined
      const profile = tincanban.getCurrentProfile()
      if (!profile) throw new Error("Identity unavailable")
      const request = await (await import("./blindCheckpoint")).prepareBlindCheckpoint(config, object, expectedSequence, profile)
      ensureIdentity()
      return request
    },
  }
}
