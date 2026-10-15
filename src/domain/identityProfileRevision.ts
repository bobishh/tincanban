import { canonicalizeJson, sha256Base64Url } from "./identity"
import type { IdentityProfileState } from "./identityProfileState"

export function identityProfileRevision(state: IdentityProfileState): Promise<string> {
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson(state)))
}
