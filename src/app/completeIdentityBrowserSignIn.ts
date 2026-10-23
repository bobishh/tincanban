import { adoptApprovedApplicationDevice } from "../domain/identity"
import type { DeviceAuthorizationApproval, DeviceAuthorizationRequest, LocalProfile } from "@meta-uber/mesh-identity"
import { initializePersonalRootCatalog } from "../statePersonalRoot"
import { defaultStorage } from "../storage"

/** Finish an approved browser sign-in before returning control to the UI. */
export async function completeIdentityBrowserSignIn(
  approval: DeviceAuthorizationApproval,
  request: DeviceAuthorizationRequest,
  currentProfile: LocalProfile,
): Promise<LocalProfile> {
  const adopted = await adoptApprovedApplicationDevice(approval, request, currentProfile)
  await initializePersonalRootCatalog(defaultStorage, adopted)
  return adopted
}
