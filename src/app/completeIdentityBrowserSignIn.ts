import { adoptApprovedApplicationDevice } from "../domain/identity"
import type { DeviceAuthorizationApproval, DeviceAuthorizationRequest, LocalProfile } from "@meta-uber/mesh-identity"
import { initializePersonalRootCatalog } from "../statePersonalRoot"
import { defaultStorage } from "../storage"
import { mergeIdentityAuthorityView } from "../sync/identityAuthorityStore"
import { saveIdentityRustyServiceCatalogApproval } from "../sync/identityRustyServiceCatalog"
import { mergeIdentityProfileState } from "../domain/identityProfileState"
import { projectIdentityProfileRoot, rootIdentityProfileState } from "../domain/identityProfileRoot"
import { identityDevicePreferencesChanged } from "../sync/identityDevicePreferenceEvents"
import { publishIdentityNameToChat } from "./identityName"

/** Finish an approved browser sign-in before returning control to the UI. */
export async function completeIdentityBrowserSignIn(
  approval: DeviceAuthorizationApproval,
  request: DeviceAuthorizationRequest,
  currentProfile: LocalProfile,
  workspaceId?: string,
): Promise<LocalProfile> {
  const adopted = await adoptApprovedApplicationDevice(approval, request, currentProfile, async (verified, ensureCurrent) => {
    if (!verified.authorityView) throw new Error("Identity approval is missing its signed global authority view")
    await mergeIdentityAuthorityView(verified.authorityView, ensureCurrent)
  })
  await saveIdentityRustyServiceCatalogApproval(request, approval)
  await initializePersonalRootCatalog(defaultStorage, adopted)
  if (approval.profileState) {
    await defaultStorage.updatePersonalRootForIdentity(adopted.identity.personId, async current => {
      if (!current || current.identity.personId !== adopted.identity.personId) throw new Error("Approved Identity profile is unavailable")
      const state = await mergeIdentityProfileState(await rootIdentityProfileState(current), approval.profileState!, adopted.identity)
      return projectIdentityProfileRoot(current, state)
    })
    identityDevicePreferencesChanged(adopted.identity.personId)
  }
  await publishIdentityNameToChat(workspaceId)
  return adopted
}
