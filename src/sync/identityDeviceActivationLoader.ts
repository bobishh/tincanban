import { readLocal } from "../localDb"
import { identityDeviceActivationKey } from "./identityDeviceActivationState"
import { hasPendingIdentityProfiles } from "./identityProfileProjectionState"
import type { ProfileProjectionResult } from "./identityProfileProjection"

/** Most startups have no pending import; load transfer validation only for durable recovery work. */
export async function recoverPendingIdentityDeviceActivation(personId: string, ensureCurrent: () => void): Promise<ProfileProjectionResult | undefined> {
  if (await readLocal(identityDeviceActivationKey(personId)) !== null) {
    ensureCurrent()
    const { resumeIdentityDeviceActivation } = await import("./identityDeviceActivation")
    ensureCurrent()
    await resumeIdentityDeviceActivation(personId, ensureCurrent, true)
  }
  return retryPendingIdentityProfiles(personId, ensureCurrent)
}

async function retryPendingIdentityProfiles(personId: string, ensureCurrent: () => void): Promise<ProfileProjectionResult | undefined> {
  if (!await hasPendingIdentityProfiles(personId)) return
  ensureCurrent()
  const { resumeIdentityProfileProjections } = await import("./identityProfileProjection")
  ensureCurrent()
  return resumeIdentityProfileProjections(personId, ensureCurrent)
}
