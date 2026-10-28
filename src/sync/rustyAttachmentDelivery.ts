import { verifyBlobBytes, type BlobDescriptor } from "@meta-uber/mesh-blob"
import type { useTincanban } from "../state"
import { getReplicaConfigurations, privateReplicaBinding } from "./privateReplicaRepository"
import { createWorkspaceAttachmentIndex } from "./attachmentIndexScope"
import { createAttachmentRepository } from "./attachmentRepository"
import { createAttachmentAccessGuard } from "./attachmentAccess"
import { AttachmentTransfer } from "./attachmentTransfer"
import { blindHash, canonicalBlindJson } from "./blindClient"
import { readStoredAttachment, writeStoredAttachmentStream } from "../attachments"
import { parseReplicaContentKeys } from "./replicaContentKeys"

type AttachmentApp = Pick<ReturnType<typeof useTincanban>, "withWorkspaceDoc" | "getCurrentProfile">

/** Keep request lifetime checks with the on-demand file path, including its final async return. */
export async function guardedAttachmentRead<T>(guard: () => void, read: () => Promise<T>): Promise<T> {
  guard()
  const result = await read()
  guard()
  return result
}

/** Read known encrypted replicas first; peers remain available when storage is offline. */
export function fetchRustyAttachment(...args: Parameters<typeof fetchAttachmentBytes>): Promise<Uint8Array | undefined> {
  return guardedAttachmentRead(args[3], () => fetchAttachmentBytes(...args))
}

async function fetchAttachmentBytes(app: AttachmentApp, workspaceId: string, descriptor: BlobDescriptor,
  ensureCurrent: () => void, fallback?: (descriptor: BlobDescriptor) => Promise<Uint8Array | undefined>): Promise<Uint8Array | undefined> {
  const peerDescriptor = structuredClone(descriptor)
  const requested = { ...peerDescriptor }
  delete requested.ticket
  ensureCurrent()
  const personId = app.getCurrentProfile()?.identity.personId
  if (!personId) throw new Error("Attachment identity is unavailable")
  const configurations = await getReplicaConfigurations(personId)
  ensureCurrent()
  const failures: unknown[] = []
  let lastGuard = async () => { ensureCurrent() }
  for (const config of configurations) {
    if (config.workspaceId !== workspaceId || config.removalPending) continue
    const binding = privateReplicaBinding(personId, config)
    const locators = (await createWorkspaceAttachmentIndex(personId, config, ensureCurrent).read())
      .filter(locator => locator.blobId === requested.blobId)
    ensureCurrent()
    if (!locators.length) continue
    const guard = await createAttachmentAccessGuard(app, config, requested, "read", ensureCurrent)
    const scope = { workspaceId: config.workspaceId, scopeId: config.scopeId, ...parseReplicaContentKeys(config) }
    lastGuard = guard
    for (const locator of locators) {
      await guard()
      const storageId = await blindHash(new TextEncoder().encode(canonicalBlindJson(["download", binding, requested, locator])))
      const repository = createAttachmentRepository(storageId, ensureCurrent)
      try {
        const source = new AttachmentTransfer(scope, config, repository, guard).downloadStream(requested, locator)
        await writeStoredAttachmentStream(requested, source, ensureCurrent)
        // Materialize only for the preview/download caller, after the durable sink verified the stream.
        const bytes = await readStoredAttachment(requested)
        await guard()
        return bytes
      } catch (cause) {
        // Access changes are terminal. A transport failure may use another replica or an authorized peer.
        await guard()
        failures.push(cause)
      }
    }
  }
  if (fallback) {
    ensureCurrent()
    await lastGuard()
    let bytes: Uint8Array | undefined
    try { bytes = await fallback(structuredClone(peerDescriptor)) } catch (cause) { failures.push(cause) }
    ensureCurrent()
    await lastGuard()
    if (bytes) {
      await verifyBlobBytes(requested, bytes)
      ensureCurrent()
      await lastGuard()
      return bytes
    }
  }
  if (failures.length) throw new AggregateError(failures, "File unavailable from Rusty and connected devices. Retry when a connection is available.")
  return undefined
}
