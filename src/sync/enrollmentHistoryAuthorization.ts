import type { LocalProfile } from "../domain/identity"
import { isDeviceRevoked } from "./durableMeshBase"
import type { WorkspaceMeshCredential } from "./peerStore"

type EnrollmentHistoryAuthorizationInput = {
  workspaceIds: string[]
  profile: LocalProfile
  remoteDeviceId: string
  isCurrent(): boolean
  readProfile(): Promise<LocalProfile>
  readCredential(workspaceId: string): Promise<WorkspaceMeshCredential | undefined>
}

export function createEnrollmentHistoryAuthorizationGuard(input: EnrollmentHistoryAuthorizationInput): () => Promise<void> {
  const workspaceIds = [...input.workspaceIds]
  const personId = input.profile.identity.personId
  const deviceId = input.profile.device.deviceId
  const remoteDeviceId = input.remoteDeviceId
  if (!workspaceIds.length || workspaceIds.some(id => typeof id !== "string" || id.length === 0) ||
      new Set(workspaceIds).size !== workspaceIds.length || typeof personId !== "string" || personId.length === 0 ||
      typeof deviceId !== "string" || deviceId.length === 0 || typeof remoteDeviceId !== "string" || remoteDeviceId.length === 0) {
    throw new Error("Enrollment history authorization binding is invalid")
  }

  const requireCurrentSession = () => {
    if (!input.isCurrent()) throw new Error("Enrollment session is no longer current")
  }
  const requireCapturedProfile = async () => {
    requireCurrentSession()
    const profile = await input.readProfile()
    requireCurrentSession()
    if (!profile || profile.identity.personId !== personId || profile.device.deviceId !== deviceId) {
      throw new Error("Enrollment identity changed")
    }
  }

  return async () => {
    await requireCapturedProfile()
    for (const workspaceId of workspaceIds) {
      requireCurrentSession()
      const credential = await input.readCredential(workspaceId)
      requireCurrentSession()
      await requireCapturedProfile()
      if (!credential || credential.workspaceId !== workspaceId) throw new Error("Enrollment workspace credential is unavailable")
      if (isDeviceRevoked(credential, personId, remoteDeviceId)) throw new Error("Enrollment device access revoked")
      requireCurrentSession()
    }
  }
}
