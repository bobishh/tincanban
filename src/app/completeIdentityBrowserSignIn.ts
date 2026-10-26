import { adoptApprovedApplicationDevice, isCurrentIdentityProfile } from "../domain/identity"
import { openApprovedIdentityCatalogAccess, type DeviceAuthorizationApproval, type DeviceAuthorizationRequest, type LocalProfile } from "@meta-uber/mesh-identity"
import { initializePersonalRootCatalog } from "../statePersonalRoot"
import { defaultStorage } from "../storage"
import { mergeIdentityAuthorityView } from "../sync/identityAuthorityStore"
import { saveIdentityRustyServiceCatalogApproval } from "../sync/identityRustyServiceCatalog"
import { mergeIdentityProfileState } from "../domain/identityProfileState"
import { projectIdentityProfileRoot, rootIdentityProfileState } from "../domain/identityProfileRoot"
import { identityDevicePreferencesChanged } from "../sync/identityDevicePreferenceEvents"
import { publishIdentityNameToChat } from "./identityName"
import { readIdentityLocalBoardPlan, selectedIdentityLocalBoardIds, type IdentityLocalBoardChoice } from "./identityLocalBoards"
import { readPendingLocalWorkspaceOwnershipIntent, transferLocallyOwnedWorkspaces } from "../sync/localWorkspaceOwnership"
import { installIdentityCatalogAccess, readIdentityCatalogAccess, type IdentityCatalogBinding } from "../sync/identityCatalogAccess"
import { useTincanban } from "../state"
import { retainIdentityCatalogPublisherAuthorization } from "../sync/identityCatalogPublisher"
import { recordIdentityBrowserSignIn } from "./identityBrowserSignIn"
import { beginIdentityBoardLoading, confirmIdentityCatalogInstalled } from "./identityBoardLoading"

async function approvedCatalogs(approval: DeviceAuthorizationApproval, request: DeviceAuthorizationRequest, profile: LocalProfile) {
  if (request.payload.version !== 3) return { available: true, entries: [] }
  const recipient = { ...profile, identity: approval.identity, certificate: approval.certificate }
  const opened = await openApprovedIdentityCatalogAccess(approval, request, recipient, { expectedExistingProfile: profile })
  if (opened.status === "unavailable") {
    recordIdentityBrowserSignIn("catalog", "failed", { errorCode: "catalog_unavailable" })
    return { available: false, entries: [] }
  }
  const entries: Array<{ access: Uint8Array; binding: IdentityCatalogBinding }> = []
  for (const entry of opened.entries) {
    const pin = approval.rustyServicePins?.find(candidate => candidate.serviceId === entry.serviceId)
    if (!pin) throw new Error("Catalog service is missing from the approved Identity")
    const binding = { origin: pin.origin, servicePublicKey: pin.servicePublicKey, catalogId: entry.catalogId }
    await readIdentityCatalogAccess(entry.access, recipient, binding)
    entries.push({ access: entry.access, binding })
  }
  return { available: true, entries }
}

/** Save verified approval independently of catalog delivery and board synchronization. */
export async function completeIdentityBrowserSignIn(
  approval: DeviceAuthorizationApproval,
  request: DeviceAuthorizationRequest,
  currentProfile: LocalProfile,
  workspaceId?: string,
  localBoardChoice?: IdentityLocalBoardChoice,
): Promise<LocalProfile> {
  const replacing = approval.identity.personId !== currentProfile.identity.personId
  const pending = replacing ? await readPendingLocalWorkspaceOwnershipIntent(currentProfile, approval.identity.personId) : []
  const localPlan = replacing ? await readIdentityLocalBoardPlan(currentProfile, approval.identity.personId) : null
  if (localPlan?.ownedBoards.length && localBoardChoice?.kind !== "add") throw new Error("Choose whether to add your local boards before signing in")
  const selected = [...new Set([...pending, ...(localPlan ? selectedIdentityLocalBoardIds(localPlan, localBoardChoice ?? { kind: "stay" }) : [])])]
  const adopted = await adoptApprovedApplicationDevice(approval, request, currentProfile, async (verified, ensureCurrent) => {
    if (!verified.authorityView) throw new Error("Identity approval is missing its signed global authority view")
    await mergeIdentityAuthorityView(verified.authorityView, ensureCurrent)
    if (selected.length) {
      const app = useTincanban()
      await transferLocallyOwnedWorkspaces({ sourceProfile: currentProfile, approvedTarget: verified,
        workspaceIds: selected, workspaceStore: { read: app.readWorkspaceBytes, readAuthorityHeads: app.readWorkspaceHeads }, ensureCurrent })
    }
  })
  const pendingBoards = await beginIdentityBoardLoading(adopted)
  await saveIdentityRustyServiceCatalogApproval(request, approval, currentProfile)
  await initializePersonalRootCatalog(defaultStorage, adopted)
  if (approval.profileState) {
    await defaultStorage.updatePersonalRootForIdentity(adopted.identity.personId, async current => {
      if (!current || current.identity.personId !== adopted.identity.personId) throw new Error("Approved Identity profile is unavailable")
      const state = await mergeIdentityProfileState(await rootIdentityProfileState(current), approval.profileState!, adopted.identity)
      return projectIdentityProfileRoot(current, state)
    })
    identityDevicePreferencesChanged(adopted.identity.personId)
  }
  const ensureCurrent = () => {
    if (!isCurrentIdentityProfile(adopted)) throw new Error("Identity changed while loading its boards")
  }
  if (request.payload.version === 3) await retainIdentityCatalogPublisherAuthorization(adopted, approval)
  try {
    const catalogs = await approvedCatalogs(approval, request, currentProfile)
    if (catalogs.available) {
      for (const entry of catalogs.entries) await installIdentityCatalogAccess(entry.access, adopted, entry.binding, ensureCurrent)
      await confirmIdentityCatalogInstalled(adopted, pendingBoards)
    }
  } catch {
    recordIdentityBrowserSignIn("catalog", "failed", { errorCode: "catalog_failed" })
  }
  await publishIdentityNameToChat(workspaceId)
  return adopted
}
