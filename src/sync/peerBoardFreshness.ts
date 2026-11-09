import { hasHeads, free } from "@automerge/automerge/slim"
import { shallowReactive } from "vue"
import { defaultStorage } from "../storage"
import { replicaConfirmationLifetime, type BoardFreshness } from "./replicationHealth"

type Peer = { workspaceId: string; deviceId: string; online: boolean; revokedAt?: string | null }
type Observation = { sequence: number; checkedAt?: number }

/** A peer observation confirms only that peer's advertised frontier for this board. */
export function createPeerBoardChecks(covers = coversAdmittedFrontier) {
  const observations = shallowReactive(new Map<string, Observation>())
  let generation = 0
  let sequence = 0
  return {
    status(workspaceId: string, peers: readonly Peer[], now: number): BoardFreshness {
      const sources = peers.filter(peer => peer.workspaceId === workspaceId && !peer.revokedAt)
      if (!sources.length) return { phase: "unknown" }
      const online = sources.filter(peer => peer.online)
      if (!online.length) return { phase: "unavailable" }
      const checkedAt = Math.max(0, ...online.map(peer => observations.get(peerKey(workspaceId, peer.deviceId))?.checkedAt ?? 0))
      if (!checkedAt) return { phase: "checking" }
      if (now - checkedAt > replicaConfirmationLifetime) return { phase: "overdue" }
      return { phase: "checked", checkedAt }
    },
    async observe(workspaceId: string, peerId: string, heads: readonly string[], ensureCurrent: () => Promise<void>) {
      const startedIn = generation
      const order = ++sequence
      const checkedAt = Date.now()
      const key = peerKey(workspaceId, peerId)
      const covered = heads.length > 0 && await covers(workspaceId, heads)
      await ensureCurrent()
      if (generation !== startedIn || (observations.get(key)?.sequence ?? 0) > order) return
      observations.set(key, { sequence: order, checkedAt: covered ? checkedAt : undefined })
    },
    reset() { generation++; observations.clear() },
  }
}

function peerKey(workspaceId: string, peerId: string) { return `${workspaceId}/${peerId}` }

async function coversAdmittedFrontier(workspaceId: string, heads: readonly string[]): Promise<boolean> {
  const saved = await defaultStorage.loadWorkspaceDoc(workspaceId)
  if (!saved) return false
  try { return hasHeads(saved.doc, [...heads]) }
  finally { free(saved.doc) }
}
