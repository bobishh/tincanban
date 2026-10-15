import type { BlobDescriptor } from "@meta-uber/mesh-blob"
import type { useTincanban } from "../state"
import { canonicalizeJson } from "../domain/identity"
import { assertSigningContextCurrent } from "../domain/signingContext"
import { workspaceBlobDescriptor } from "../app/workspaceMetadata"
import { authorityValidationFingerprint, readWorkspaceSigningAuthority, workspaceRole } from "./changeAuthorization"
import type { BlindReplicaConfig } from "./blindReplication"
import { getPrivateReplicaProgress } from "./privateReplicaRepository"
import { workspaceSigningContext } from "./workspaceSigning"

type AttachmentApp = Pick<ReturnType<typeof useTincanban>, "readWorkspaceDoc" | "getCurrentProfile">

/** Bind private file I/O to the current device, connection and admitted document reference. */
export async function createAttachmentAccessGuard(app: AttachmentApp, config: BlindReplicaConfig,
  descriptor: BlobDescriptor, mode: "read" | "upload", ensureCurrent: () => void = () => {}): Promise<() => Promise<void>> {
  const connection = structuredClone(config)
  const requested = structuredClone(descriptor)
  const active = app.getCurrentProfile()
  if (!active) throw new Error("Attachment identity is unavailable")
  const profile = { ...active, identity: structuredClone(active.identity), device: structuredClone(active.device),
    certificate: structuredClone(active.certificate), privateKeys: { ...active.privateKeys } }
  const personId = profile.identity.personId
  const deviceId = profile.device.deviceId
  const guardIdentity = () => {
    ensureCurrent()
    const current = app.getCurrentProfile()
    if (current?.identity.personId !== personId || current.identity.publicKey !== profile.identity.publicKey ||
        current.device.deviceId !== deviceId || current.device.publicKey !== profile.device.publicKey ||
        current.certificate.signature !== profile.certificate.signature) {
      throw new Error("Attachment identity changed during transfer")
    }
  }
  const readDocument = async () => {
    guardIdentity()
    await getPrivateReplicaProgress(personId, connection)
    const doc = await app.readWorkspaceDoc(connection.workspaceId)
    guardIdentity()
    const matches = workspaceBlobDescriptor(doc, requested.blobId, reference => descriptorIdentity(reference) === descriptorIdentity(requested))
    if (doc.id !== connection.workspaceId || !matches) {
      throw new Error("Attachment reference is missing or changed")
    }
    return doc
  }
  let doc = await readDocument()
  const { context } = await workspaceSigningContext(doc, profile, `attachment-${mode}`, "workspaceId", undefined, {
    readAuthority: async () => {
      doc = await readDocument()
      const authority = await readWorkspaceSigningAuthority(connection.workspaceId)
      guardIdentity()
      return authority
    },
    authorityFingerprint: authorityValidationFingerprint,
    workspaceRole: (_captured, signer) => workspaceRole(doc, signer),
  })
  return async () => {
    guardIdentity()
    await assertSigningContextCurrent(context)
    await getPrivateReplicaProgress(personId, connection)
    guardIdentity()
  }
}

function descriptorIdentity(value: BlobDescriptor): string {
  return canonicalizeJson([value.blobId, value.name, value.mediaType, value.size, value.hash ?? ""])
}
