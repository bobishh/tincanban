import { authorizeIdentityDataDevice, verifyIdentityAuthorityView, type VerifiedIdentityAuthorityView } from "@meta-uber/mesh-identity"
import { readLocal } from "../localDb"

export function identityAuthorityViewKey(personId: string): string {
  return `tincanban.identity-authority-view.v1.${personId}`
}

/** Return only a stored, verified Identity view; missing state means this device has not learned one yet. */
export async function readLearnedIdentityAuthorityView(personId: string): Promise<VerifiedIdentityAuthorityView | null> {
  const raw = await readLocal(identityAuthorityViewKey(personId))
  if (raw === null) return null
  let value: unknown
  try { value = JSON.parse(raw) as unknown }
  catch { throw new Error("Stored Identity authority view is malformed") }
  const view = await verifyIdentityAuthorityView(value)
  if (view.personId !== personId) throw new Error("Stored Identity authority view belongs to another person")
  return view
}

/** Apply a learned global Identity revocation at every local signing boundary. */
export async function assertLearnedIdentityDeviceActive(personId: string, deviceId: string): Promise<string | null> {
  const view = await readLearnedIdentityAuthorityView(personId)
  if (!view) return null
  await authorizeIdentityDataDevice(view, deviceId)
  return view.viewDigest
}
