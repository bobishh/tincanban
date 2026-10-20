import type { LocalProfile } from "../domain/identity"
import { canonicalizeJson } from "../domain/identity"
import type { WorkspaceSetStore } from "./workspaceSet"
import type { PeerStore } from "./peerStore"
import { getReplicaConfigurations } from "./privateReplicaRepository"
import { createBoardStorageAccess, receiveBoardStorageAccess, selectBoardStorageAccess, verifyBoardStorageAccess } from "./workspaceRustyAccess"
import type { BoardStorageAccess } from "../domain/boardStorageAccess"

/** Board access is separate from personal settings, and travels only over an authenticated participant channel. */
export function withWorkspaceRustyAccess(store: WorkspaceSetStore, input: {
  workspaceId: string; profile: LocalProfile; remotePersonId: string; remoteDeviceId: string;
  peers: PeerStore; guard: () => Promise<void>
}): WorkspaceSetStore {
  const attestations = new Map<string, BoardStorageAccess>()
  const authority = async () => {
    await input.guard()
    const credential = await input.peers.getWorkspaceCredential(input.workspaceId)
    if (!credential) throw new Error("Board storage authority is unavailable")
    await input.guard()
    return credential
  }
  return { ...store,
    readMesh: async id => {
      if (id !== input.workspaceId) throw new Error("Board storage exchange changed workspace")
      const current = await authority()
      const remote = await input.peers.getPeer(id, input.remoteDeviceId)
      if (!remote || remote.personId !== input.remotePersonId) throw new Error("Board storage recipient changed")
      const configurations = (await getReplicaConfigurations(input.profile.identity.personId))
        .filter(config => config.workspaceId === id && !config.removalPending)
      const connections = []
      for (const config of configurations) {
        await input.guard()
        let access = config.boardAccess
        if (!access) {
          if (input.profile.identity.personId !== current.ownerPersonId) continue
          const key = canonicalizeJson([config.origin, config.scopeId, config.policyRevision, config.keyEpoch, config.minimumWriterVersion,
            config.readToken, config.writeToken, config.contentKey, config.historicalContentKeys, config.historicalContentKeyVariants])
          access = attestations.get(key)
          if (!access) {
            access = await createBoardStorageAccess(input.profile, config, () => authority(), input.guard)
            if (attestations.size >= 32) attestations.clear()
            attestations.set(key, access)
          }
        } else await verifyBoardStorageAccess(config, id, current, config.boardAccess?.mode === "write" ? "editor" : "visitor")
        const selected = selectBoardStorageAccess(access, config.writeToken, remote.role)
        if (selected) connections.push(selected)
      }
      const mesh = await store.readMesh?.(id)
      await input.guard()
      return connections.length ? { ...mesh as object, boardStorageAccess: connections } : mesh
    },
    mergeMesh: async (id, raw) => {
      if (id !== input.workspaceId || !raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid board storage metadata")
      const { boardStorageAccess, ...mesh } = raw as Record<string, unknown>
      await input.guard()
      await store.mergeMesh?.(id, mesh)
      if (boardStorageAccess === undefined) return
      const current = await authority()
      const profile = input.profile
      const grant = current.localGrant as { payload?: { role?: string } } | undefined
      const role = current.ownerPersonId === profile.identity.personId ? "owner" : grant?.payload?.role
      if (role !== "owner" && role !== "editor" && role !== "visitor") throw new Error("Current participant cannot receive board storage")
      await receiveBoardStorageAccess(profile.identity.personId, id, current, role, boardStorageAccess, input.guard)
    },
  }
}
