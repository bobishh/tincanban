import type { WorkspaceDocumentV2 } from "../domain/model"
import type { LocalProfile } from "../domain/identity"
import type { CommandSigningContext } from "../domain/commands"
import { localWorkspaceAdmissionAuthority } from "./changeAuthorization"
import { resolveLocalSigningContext } from "../domain/localSigningContext"

/** Both transaction proofs retain one live authority revision; neither can acquire replacement rights mid-command. */
export async function localCommandSigningContext(doc: Pick<WorkspaceDocumentV2, "id" | "ownerPersonId">,
  profile: LocalProfile, authorize: () => Promise<void>): Promise<CommandSigningContext> {
  const revision = (await localWorkspaceAdmissionAuthority(doc, profile)).fingerprint
  const ensureCurrent = async () => {
    await authorize()
    if ((await localWorkspaceAdmissionAuthority(doc, profile)).fingerprint !== revision) {
      throw new Error("Workspace authority changed while signing a transaction")
    }
  }
  return (purpose, binding) => resolveLocalSigningContext(profile, purpose, { ...binding, documentId: doc.id }, {
    ensureCurrent, currentAuthority: async () => (await localWorkspaceAdmissionAuthority(doc, profile)).fingerprint,
  })
}
