import { BLOB_SIGNATURE_DOMAIN, type BlobRequestPayload, type BlobRequestSigner } from "@meta-uber/mesh-blob"
import type { LocalProfile } from "../domain/identity"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { signWithContext } from "../domain/signingContext"

/** Bind peer chunk requests to the current member, exact file and caller's live session generation. */
export async function blobRequestSigning(profile: LocalProfile, workspaceId: string, blobId: string,
  currentAuthority: () => Promise<string>): Promise<BlobRequestSigner> {
  profile = structuredClone(profile)
  const revision = await currentAuthority()
  const unchanged = async () => {
    if (await currentAuthority() !== revision) throw new Error("Blob request authority or session changed while signing")
    return revision
  }
  const binding = { conversationId: workspaceId, blobId, requesterPersonId: profile.identity.personId,
    requesterDeviceId: profile.device.deviceId }
  const options = { currentAuthority: unchanged, domain: BLOB_SIGNATURE_DOMAIN }
  // Resolve before any request/stream I/O; this checks the full certificate chain and private key.
  const context = await resolveLocalSigningContext(profile, "blob-request", binding, options)
  return Object.freeze({ personId: profile.identity.personId, deviceId: profile.device.deviceId,
    async sign(payload: BlobRequestPayload) { return signWithContext(context, structuredClone(payload)) },
  })
}
