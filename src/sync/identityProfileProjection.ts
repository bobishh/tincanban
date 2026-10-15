import { defaultStorage } from "../storage"
import { acknowledgeIdentityProfileProjection, readIdentityProfileQueue } from "./identityProfileProjectionQueue"
import { hasPendingIdentityProfiles } from "./identityProfileProjectionState"

export type ProfileProjectionResult = { projected: number; pending: Array<{ workspaceId: string; reason: string }> }

/** Queue storage is already committed. A missing/rejected workspace does not undo identity delivery. */
export async function resumeIdentityProfileProjections(personId: string, ensureCurrent: () => void): Promise<ProfileProjectionResult> {
  ensureCurrent()
  const result: ProfileProjectionResult = { projected: 0, pending: [] }
  if (!await hasPendingIdentityProfiles(personId)) return result
  ensureCurrent()
  const root = await defaultStorage.loadPersonalRoot()
  if (!root || root.identity.personId !== personId) throw new Error("Identity changed before private profile projection")
  const observations = await readIdentityProfileQueue(root.identity)
  for (const observation of observations) {
    ensureCurrent()
    if (!root.workspaces[observation.workspaceId] || root.workspaces[observation.workspaceId].forgotten) {
      result.pending.push({ workspaceId: observation.workspaceId, reason: "Workspace reference is unavailable" })
      continue
    }
    try {
      const { projectPrivateProfileObservation } = await import("../chat/privateProfileProjection")
      ensureCurrent()
      await projectPrivateProfileObservation(observation.workspaceId, observation.record, ensureCurrent)
      await acknowledgeIdentityProfileProjection(root.identity, observation, ensureCurrent)
      result.projected++
    } catch (cause) {
      // The original record remains durable; admission and storage are retried after workspace installation.
      ensureCurrent()
      result.pending.push({ workspaceId: observation.workspaceId,
        reason: cause instanceof Error ? cause.message : "Profile projection unavailable" })
    }
  }
  return result
}
