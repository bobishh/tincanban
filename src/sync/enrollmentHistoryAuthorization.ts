import { canonicalizeJson, type LocalProfile } from "../domain/identity"
import { resolveLearnedIdentityAccess } from "../domain/identityAuthority"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { WorkspaceAuthorityRecord, WorkspaceAuthorizationSnapshot, WorkspaceMeshCredential } from "./peerStore"
import { workspaceAuthorityFingerprint } from "./authorityFingerprint"

type EnrollmentHistoryAuthorizationInput = {
  workspaceIds: string[]
  profile: LocalProfile
  remoteDeviceId: string
  isCurrent(): boolean
  readProfile(): Promise<LocalProfile>
  readWorkspaces(workspaceIds: readonly string[]): Promise<WorkspaceAuthorizationSnapshot[]>
}

export function createEnrollmentHistoryAuthorizationGuard(input: EnrollmentHistoryAuthorizationInput): () => Promise<void> {
  const workspaceIds = [...input.workspaceIds]
  const personId = input.profile.identity.personId
  const deviceId = input.profile.device.deviceId
  const remoteDeviceId = input.remoteDeviceId
  const profileBinding = (profile: LocalProfile) => canonicalizeJson([profile.identity.personId, profile.identity.publicKey,
    profile.device.deviceId, profile.device.publicKey, profile.certificate])
  const expectedProfile = profileBinding(input.profile)
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
    if (!profile || profileBinding(profile) !== expectedProfile) {
      throw new Error("Enrollment identity changed")
    }
  }

  return async () => {
    await requireCapturedProfile()
    const assertGlobalCurrent = await resolveLearnedIdentityAccess([
      { personId, deviceId }, { personId, deviceId: remoteDeviceId },
    ])
    const readWorkspaces = async () => {
      requireCurrentSession()
      const snapshots = await input.readWorkspaces(workspaceIds)
      requireCurrentSession()
      if (snapshots.length !== workspaceIds.length || snapshots.some((item, index) => item.workspaceId !== workspaceIds[index])) {
        throw new Error("Enrollment workspace authorization snapshot is incomplete")
      }
      return snapshots
    }
    const previous = await readWorkspaces()
    await requireCapturedProfile()
    const latest = await readWorkspaces()
    for (let index = 0; index < previous.length; index++) {
      const { workspaceId, credential, authority } = previous[index]!
      const { credential: latestCredential, authority: latestAuthority } = latest[index]!
      if (!credential || credential.workspaceId !== workspaceId) throw new Error("Enrollment workspace credential is unavailable")
      if (!latestCredential || latestCredential.transportSecret !== credential.transportSecret ||
          workspaceAuthorityFingerprint([credential], authority ? [authority] : []) !==
          workspaceAuthorityFingerprint([latestCredential], latestAuthority ? [latestAuthority] : [])) {
        throw new Error("Enrollment workspace authority changed during history access")
      }
      assertEnrollmentMembership(latestCredential, latestAuthority, personId, deviceId, remoteDeviceId)
      requireCurrentSession()
    }
    await assertGlobalCurrent()
    requireCurrentSession()
  }
}

/** Current Identity and workspace ledgers independently constrain both ends of a same-person history transfer. */
function assertEnrollmentMembership(credential: WorkspaceMeshCredential, authority: WorkspaceAuthorityRecord | null,
  personId: string, localDeviceId: string, remoteDeviceId: string): void {
  const state = meshRustRuntime().state
  for (const current of [credential, ...(authority ? [authority] : [])]) {
    if (current.workspaceId !== credential.workspaceId || current.ownerPersonId !== credential.ownerPersonId ||
        current.ownerPublicKey !== credential.ownerPublicKey || current.epoch !== credential.epoch) {
      throw new Error("Enrollment workspace authority binding changed")
    }
    if (state.isDeviceRevoked(current, personId, localDeviceId) || state.isDeviceRevoked(current, personId, remoteDeviceId)) {
      throw new Error("Enrollment device access revoked")
    }
    if (state.hasAuthorityConflict(current) || state.isGrantRevoked(current, personId, credential.localGrant ?? null) ||
        state.hasLeftWorkspace(current, personId, credential.localGrant ?? null)) {
      throw new Error("Enrollment membership access revoked")
    }
  }
}
