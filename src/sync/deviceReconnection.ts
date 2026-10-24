import { bootstrapIdentity, renewDeviceIdentity } from "../domain/identity"
import type { WorkspaceJoinInvitation } from "@meta-uber/mesh-pairing"
import { userMessage, type DeviceSyncState } from "./deviceSyncState"

export function canReconnectDevice(state: DeviceSyncState) {
  return state.canRenewDevice.value && state.parsedInvite.value?.kind === "workspace-join" &&
    (state.step.value === "workspace-reconnect-confirm" || state.step.value === "error" && /Device access revoked/i.test(state.error.value))
}

export async function reconnectWorkspaceDevice(context: {
  state: DeviceSyncState
  stop: () => Promise<void>
  resetMesh: () => Promise<void>
  identityChanged?: () => Promise<void>
  refreshProfile: () => Promise<unknown>
  join: () => Promise<void>
}) {
  const { state } = context
  if (!canReconnectDevice(state)) return
  const invite = state.parsedInvite.value!
  if (Date.parse(invite.expiresAt) <= Date.now()) {
    state.step.value = "error"
    state.error.value = "This invitation has expired. Ask the owner for a new link."
    return
  }
  state.step.value = "workspace-guest-waiting"
  try {
    await context.stop()
    await context.resetMesh()
    const [identitySdk, identityProfileRoot, proofs, storage, enrollment, authorityStore] = await Promise.all([
      import("@meta-uber/mesh-identity"), import("../domain/identityProfileRoot"), import("../domain/proofs"),
      import("../storage"), import("./enrollment"), import("./identityAuthorityStore"),
    ])
    const previousProfile = await bootstrapIdentity()
    const currentAuthority = await authorityStore.requireIdentityAuthorityView(previousProfile.identity.personId)
    const root = await storage.defaultStorage.loadPersonalRoot()
    if (!root || root.identity.personId !== previousProfile.identity.personId) {
      throw new Error("Personal Identity root is unavailable")
    }
    const currentCertificateKnown = currentAuthority.certificates.some(certificate =>
      certificate.payload.deviceId === previousProfile.device.deviceId)
    if (currentCertificateKnown) {
      await enrollment.assertActiveIdentityEnrollmentDevice(currentAuthority, currentAuthority, previousProfile.identity.personId,
        previousProfile.device.deviceId, previousProfile.device.publicKey)
    }
    const profile = currentCertificateKnown ? await renewDeviceIdentity() : previousProfile
    await proofs.defaultProofStore.putCertificate(await proofs.certHashDefault(profile.certificate), profile.certificate)
    const renewedAuthority = await identitySdk.createLocalRootIdentityAuthorityView(profile,
      { certificates: [...currentAuthority.certificates, profile.certificate], revocations: currentAuthority.revocations },
      await identityProfileRoot.rootIdentityProfileState(root))
    const acceptedAuthority = await authorityStore.mergeIdentityAuthorityView(renewedAuthority)
    await enrollment.assertActiveIdentityEnrollmentDevice(acceptedAuthority, acceptedAuthority, profile.identity.personId,
      profile.device.deviceId, profile.device.publicKey)
    await context.identityChanged?.()
    await context.refreshProfile()
    state.step.value = "workspace-merge-confirm"
    await context.join()
  } catch (error) {
    state.step.value = "error"
    state.error.value = userMessage(error, "Couldn’t reconnect this device.")
  }
}

export async function showWorkspaceJoinStep(state: DeviceSyncState, invite: WorkspaceJoinInvitation,
  localIds: string[], revokedIds: () => Promise<string[]>) {
  state.invitationWorkspaces.value = invite.workspaces || [{ id: invite.workspaceId, title: invite.workspaceTitle }]
  state.invitationWorkspaceTitle.value = state.invitationWorkspaces.value.map(item => item.title).join(", ")
  const revoked = await revokedIds()
  if (state.canRenewDevice.value && state.invitationWorkspaces.value.some(item => revoked.includes(item.id))) {
    state.step.value = "workspace-reconnect-confirm"
    return
  }
  state.step.value = state.invitationWorkspaces.value.some(item => localIds.includes(item.id)) ? "workspace-merge-confirm" : "workspace-guest"
}
