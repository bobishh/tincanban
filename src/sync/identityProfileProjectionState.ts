import { readLocal } from "../localDb"

export const identityProfileProjectionKey = (personId: string) => `tincanban.identity-profile-projections.v1.${personId}`

/** Only an exact known empty registry skips validation; unfamiliar bytes remain recoverable. */
export async function hasPendingIdentityProfiles(personId: string): Promise<boolean> {
  const raw = await readLocal(identityProfileProjectionKey(personId))
  if (raw === null) return false
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return true
    const value = parsed as Record<string, unknown>
    return !(value.version === 1 && value.personId === personId &&
      Array.isArray(value.observations) && value.observations.length === 0 && Object.keys(value).length === 3)
  } catch { return true }
}
