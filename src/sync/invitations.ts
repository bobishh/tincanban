import { createWorkspaceGrant } from "../domain/proofs"
import type { ScopedInvitation } from "@meta-uber/mesh-pairing"
import type { DeviceCertificate, WorkspaceGrant } from "../domain/model"
import {
  sha256Base64Url,
  type LocalProfile,
} from "../domain/identity"
import type { VerifiedSigningContext } from "../domain/signingContext"

type InvitationStatus = "pending" | "redeeming" | "consumed" | "cancelled" | "expired"

export type StoredInvitation = ScopedInvitation & {
  status: InvitationStatus
  claimedByDeviceId?: string
  approvedAt?: string
}

let inMemoryInvitations = new Map<string, StoredInvitation>()

export function resetInvitationStorageForTest() {
  inMemoryInvitations = new Map<string, StoredInvitation>()
}

export async function deriveTranscriptAuthCode(
  secret: string,
  keyA: string,
  keyB: string
): Promise<string> {
  const sortedKeys = [keyA, keyB].sort().join(":")
  const input = `${secret}:${sortedKeys}`
  const hash = await sha256Base64Url(new TextEncoder().encode(input))

  // Extract a 6-digit numeric code from hash
  let num = 0
  for (let i = 0; i < hash.length && i < 8; i++) {
    num = (num * 31 + hash.charCodeAt(i)) >>> 0
  }
  const digits = String(num % 1000000).padStart(6, "0")
  return `${digits.slice(0, 3)} ${digits.slice(3)}`
}

export class InvitationService {
  async saveIssuedInvitation(invite: ScopedInvitation): Promise<StoredInvitation> {
    const stored: StoredInvitation = {
      ...invite,
      status: "pending",
    }
    inMemoryInvitations.set(invite.invitationId, stored)
    return stored
  }

  async getInvitation(invitationId: string): Promise<StoredInvitation | null> {
    const found = inMemoryInvitations.get(invitationId)
    if (!found) return null

    // Check expiry
    if (found.status === "pending" || found.status === "redeeming") {
      if (Date.parse(found.expiresAt) <= Date.now()) {
        found.status = "expired"
      }
    }
    return found
  }

  async cancelInvitation(invitationId: string): Promise<void> {
    const found = inMemoryInvitations.get(invitationId)
    if (found) {
      found.status = "cancelled"
    }
  }

  async claimInvitation(
    invitationId: string,
    recipientDeviceId: string
  ): Promise<{ ok: true; invitation: StoredInvitation } | { ok: false; error: string }> {
    const invite = await this.getInvitation(invitationId)
    if (!invite) {
      return { ok: false, error: "Invitation not found" }
    }

    if (invite.status === "cancelled") {
      return { ok: false, error: "Invitation has been cancelled" }
    }
    if (invite.status === "expired" || Date.parse(invite.expiresAt) <= Date.now()) {
      return { ok: false, error: "Invitation has expired" }
    }
    if (invite.status === "consumed") {
      return { ok: false, error: "Invitation has already been consumed" }
    }

    if (invite.claimedByDeviceId && invite.claimedByDeviceId !== recipientDeviceId) {
      return { ok: false, error: "Competing recipient is already redeeming this invitation" }
    }

    invite.status = "redeeming"
    invite.claimedByDeviceId = recipientDeviceId
    return { ok: true, invitation: invite }
  }

  async approveEnrollment(
    invitationId: string,
    recipientDevice: { deviceId: string; publicKey: string; displayName?: string },
    profile: LocalProfile,
    suppliedContext?: VerifiedSigningContext,
  ): Promise<{ ok: true; certificate: DeviceCertificate } | { ok: false; error: string }> {
    const requestedDevice = structuredClone(recipientDevice)
    const requestedProfile = structuredClone(profile)
    const requestedInvitationId = invitationId
    const { approveEnrollmentCertificate } = await import("./enrollmentCertificate")
    return approveEnrollmentCertificate(requestedInvitationId, requestedDevice, requestedProfile, suppliedContext, {
      getInvitation: id => this.getInvitation(id),
      consume: (invite, approvedAt, stillCurrent) => {
        const current = inMemoryInvitations.get(invite.invitationId) ?? null
        if (!current || !stillCurrent(current, Date.now())) return false
        current.status = "consumed"
        current.approvedAt = approvedAt
        return true
      },
    })
  }

  async approveWorkspaceJoin(
    invitationId: string,
    recipientPersonId: string,
    workspaceId: string,
    profile: LocalProfile,
    workspaceOwnerPersonId?: string,
    role: "editor" | "visitor" = "visitor",
    accessEpoch = 1,
  ): Promise<{ ok: true; grant: WorkspaceGrant } | { ok: false; error: string }> {
    const invite = await this.getInvitation(invitationId)
    if (!invite) {
      return { ok: false, error: "Invitation not found" }
    }
    if (invite.kind !== "workspace-join") {
      return { ok: false, error: "Not a workspace-join invitation" }
    }

    const ownerId = workspaceOwnerPersonId || invite.issuerPersonId
    if (profile.identity.personId !== ownerId) {
      return { ok: false, error: "Only the workspace owner can issue workspace grants" }
    }

    const signedGrant = await createWorkspaceGrant(profile, workspaceId, recipientPersonId, role, accessEpoch)

    invite.status = "consumed"
    invite.approvedAt = new Date().toISOString()

    return { ok: true, grant: signedGrant }
  }

  async approveWorkspaceJoinSet(
    invitationId: string,
    recipientPersonId: string,
    workspaceIds: string[],
    profile: LocalProfile,
    workspaceOwners?: Map<string, string>,
    role: "editor" | "visitor" = "visitor",
    accessEpochs?: Map<string, number>,
  ): Promise<{ ok: true; grants: WorkspaceGrant[] } | { ok: false; error: string }> {
    const invite = await this.getInvitation(invitationId)
    if (!invite) {
      return { ok: false, error: "Invitation not found" }
    }
    if (invite.kind !== "workspace-join") {
      return { ok: false, error: "Not a workspace-join invitation" }
    }

    // Verify ownership for all requested workspaces
    for (const wsId of workspaceIds) {
      const ownerId = workspaceOwners?.get(wsId) || invite.issuerPersonId
      if (profile.identity.personId !== ownerId) {
        return { ok: false, error: `Only the workspace owner can issue workspace grants for workspace ${wsId}` }
      }
    }

    const grants: WorkspaceGrant[] = []

    for (const wsId of workspaceIds) {
      grants.push(await createWorkspaceGrant(profile, wsId, recipientPersonId, role, accessEpochs?.get(wsId) ?? 1))
    }

    invite.status = "consumed"
    invite.approvedAt = new Date().toISOString()

    return { ok: true, grants }
  }
}

export const defaultInvitationService = new InvitationService()
