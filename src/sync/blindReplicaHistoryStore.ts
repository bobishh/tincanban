import { receiveBlindReplicaHistory, type ReceiveContext } from "./blindReplicaHistoryReceive"
import type { BlindReplicaStore } from "./blindReplication"

export function createBlindHistoryStoreHooks(context: ReceiveContext): Pick<BlindReplicaStore,
  "merge" | "receiveHistoryBaseline" | "prepareHistoryCheckpoint"> {
  const { config, owner, tincanban, guardIdentity, readReplicaProgress } = context
  const covered = async (document: Uint8Array) => {
    guardIdentity()
    const { isCoveredBlindHistoricalSnapshot } = await import("./blindReplicaHistoricalSnapshot")
    return isCoveredBlindHistoricalSnapshot({ config, owner, document, guardIdentity,
      ensureCurrent: async () => { guardIdentity(); await readReplicaProgress(); guardIdentity() } })
  }
  return {
    merge: async (id, bytes, authorization) => {
      if (await covered(bytes)) return
      guardIdentity()
      await tincanban.mergeAuthorizedWorkspace(id, bytes, authorization)
    },
    receiveHistoryBaseline: async (id, bytes, authorization, history) => {
      if (await covered(bytes)) return
      await receiveBlindReplicaHistory(context, id, bytes, authorization, history)
    },
    prepareHistoryCheckpoint: async (bytes, object, sequence, baselineId, existing, candidate, history) => {
      await readReplicaProgress()
      const { prepareHistoryBasisCheckpoint } = await import("./blindHistoryCheckpointAdmission")
      return prepareHistoryBasisCheckpoint(tincanban, config, bytes, object, sequence, baselineId, guardIdentity, existing, candidate, history)
    },
  }
}
