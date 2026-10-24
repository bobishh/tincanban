import {
  mergeIdentityAuthorityViews,
  verifyIdentityAuthorityView,
  type IdentityAuthorityView,
  type VerifiedIdentityAuthorityView,
} from "@meta-uber/mesh-identity"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { identityAuthorityViewKey as domainIdentityAuthorityViewKey, readLearnedIdentityAuthorityView } from "../domain/identityAuthority"

const keyFor = domainIdentityAuthorityViewKey
/** Load the one durable, cryptographically verified authority view for a person. */
async function readIdentityAuthorityView(personId: string): Promise<VerifiedIdentityAuthorityView | null> {
  return readLearnedIdentityAuthorityView(personId)
}

export async function requireIdentityAuthorityView(personId: string): Promise<VerifiedIdentityAuthorityView> {
  const view = await readIdentityAuthorityView(personId)
  if (!view) throw new Error("Current Identity authority view is required before private Rusty access")
  return view
}

/** Persist a verified view with compare-and-swap; stale or forked revocation history cannot replace it. */
export async function mergeIdentityAuthorityView(
  incomingValue: IdentityAuthorityView,
  ensureCurrent: () => void = () => {},
): Promise<VerifiedIdentityAuthorityView> {
  const incoming = await verifyIdentityAuthorityView(incomingValue)
  const key = keyFor(incoming.personId)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    ensureCurrent()
    const previousRaw = await readLocal(key)
    let merged = incoming
    if (previousRaw !== null) {
      let previous: unknown
      try { previous = JSON.parse(previousRaw) as unknown }
      catch { throw new Error("Stored Identity authority view is malformed") }
      merged = await mergeIdentityAuthorityViews(previous, incoming)
    }
    ensureCurrent()
    const next = JSON.stringify(merged)
    if (await compareAndSwapLocal({ conditions: [{ key, value: previousRaw }], writes: [{ key, value: next }] }, ensureCurrent)) {
      return await verifyIdentityAuthorityView(merged)
    }
  }
  throw new Error("Identity authority view changed repeatedly; retry required")
}
