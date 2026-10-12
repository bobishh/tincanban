import { load, getHeads, free } from "@automerge/automerge/slim"
import type { useTincanban } from "../state"
import { exportAuthorizationBundle } from "./changeAuthorization"
import { exportChat, receiveChat } from "../chat/service"
import { meshTrace } from "./meshTrace"
import { BlindReplica, type BlindReplicaConfig } from "./blindReplication"
import { checkpointHooks } from "./blindCheckpointAdmission"

export function createBlindReplica(config: BlindReplicaConfig, tincanban: ReturnType<typeof useTincanban>, ensureIdentity: () => void,
  persist: (config: BlindReplicaConfig) => Promise<void>) {
  ensureIdentity()
  return new BlindReplica({ ...config }, {
    read: async id => { ensureIdentity(); return tincanban.readWorkspaceBytes(id) },
    authorization: bytes => exportAuthorizationBundle(bytes),
    merge: async (id, bytes, authorization) => { ensureIdentity(); await tincanban.mergeAuthorizedWorkspace(id, bytes, authorization) },
    readChat: async id => { ensureIdentity(); const chat = await exportChat(id); return { ...chat, typing: [] } },
    mergeChat: async (id, chat) => { ensureIdentity(); await receiveChat(id, chat, true) },
    documentRevision: async bytes => {
      const doc = load(bytes)
      try { return getHeads(doc).sort().join(",") } finally { free(doc) }
    },
    ...checkpointHooks(tincanban, config, ensureIdentity),
    diagnostic: (event, detail) => meshTrace(event, detail, event.endsWith("failed") ? "warn" : "info"),
    persist,
  })
}

