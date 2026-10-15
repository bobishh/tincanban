import { readLocal, updateLocal } from "./localDb"
import { identityStateRevisionKey, parseIdentityRevision } from "./identityStateContent"
export { identityStateRevisionKey } from "./identityStateContent"

/** Small durable frontier shared by local identity-state writers; it contains no user content. */
export async function readIdentityStateRevision(): Promise<string> {
  const saved = await readLocal(identityStateRevisionKey)
  const raw = saved ?? await updateLocal(identityStateRevisionKey, current => current ?? JSON.stringify(parseIdentityRevision(null)))
  const revision = parseIdentityRevision(raw)
  return `${revision.generation}:${revision.revision}`
}
