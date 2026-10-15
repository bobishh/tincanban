import { isAvatarDataUrl, isMemberProfileData } from "../domain/avatarData"
import type { PersonalRootDocumentV1 } from "../domain/model"
import type { LocalProfile } from "../domain/identity"
import { defaultStorage } from "../storage"
import { identityDevicePreferencesChanged } from "../sync/identityDevicePreferenceEvents"

export type IdentityPhoto = NonNullable<PersonalRootDocumentV1["photo"]>
export function parseIdentityPhoto(value: unknown): IdentityPhoto | undefined {
  if (!value || !isMemberProfileData(JSON.stringify(value))) return undefined
  return value as IdentityPhoto
}
export async function saveIdentityPhoto(profile: LocalProfile, avatarData: string | null,
  storage: Pick<typeof defaultStorage, "updatePersonalRootForIdentity"> = defaultStorage): Promise<IdentityPhoto> {
  if (avatarData !== null && !isAvatarDataUrl(avatarData)) throw new Error("Profile photo must be a small WebP or JPEG image")
  const { editIdentityProfileRoot } = await import("../domain/identityProfileRoot")
  const root = await storage.updatePersonalRootForIdentity(profile.identity.personId, async current => {
    if (current?.identity.personId !== profile.identity.personId) throw new Error("Identity catalog is unavailable")
    return editIdentityProfileRoot(current, profile, "photo", { avatarData, changedAt: new Date().toISOString() })
  })
  if (!root?.photo) throw new Error("Identity catalog is unavailable")
  identityDevicePreferencesChanged(profile.identity.personId)
  return root.photo
}
