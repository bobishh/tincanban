import type { LocalProfile } from "../domain/identity"
import { defaultProofStore } from "../domain/proofs"
import { resolveSigningContext } from "../domain/signingContext"
import { authorizeLocalChanges, prepareLocalChangeAuthorizations, recordGenesisAuthority,
  type WorkspaceSigningContextFactory } from "./changeAuthorization"

/** An independent historical host owns its signer; live workspace guards still come from the production producer. */
function historicalWorkspaceSigner(profile: LocalProfile): WorkspaceSigningContextFactory {
  return async (purpose, binding, currentAuthority) => resolveSigningContext({ profile, purpose, binding,
    certificates: await defaultProofStore.listCertificates(), authorityRevision: await currentAuthority(),
    current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId,
      authorityRevision: await currentAuthority() }),
  })
}

export function recordHistoricalGenesis(...[doc, profile]: Parameters<typeof recordGenesisAuthority>) {
  return recordGenesisAuthority(doc, profile, historicalWorkspaceSigner(profile))
}

export function prepareHistoricalAuthorizations(...[doc, profile, hashes]: Parameters<typeof prepareLocalChangeAuthorizations>) {
  return prepareLocalChangeAuthorizations(doc, profile, hashes, historicalWorkspaceSigner(profile))
}

export function authorizeHistoricalChanges(...[doc, profile, hashes]: Parameters<typeof authorizeLocalChanges>) {
  return authorizeLocalChanges(doc, profile, hashes, historicalWorkspaceSigner(profile))
}
