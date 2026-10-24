import type { useTincanban } from "../state"
import { readStoredAttachmentStream } from "../attachments"
import { BLOB_CHUNK_BYTES } from "@meta-uber/mesh-blob"
import { blindHash, canonicalBlindJson, discoverBlindKeeper } from "./blindClient"
import { downloadBlindBlob, uploadBlindBlob } from "./blindBlobClient"
import type { BlindReplicaConfig } from "./blindReplication"
import { createWorkspaceAttachmentIndex, attachmentIndexBinding } from "./attachmentIndexScope"
import { createAttachmentRepository } from "./attachmentRepository"
import { createAttachmentAccessGuard } from "./attachmentAccess"
import { AttachmentTransfer } from "./attachmentTransfer"
import { confirmRustyAttachmentCoverage } from "./attachmentCoverage"
import { listWorkspaceAttachments } from "./workspaceAttachments"
import { WorkspaceAttachmentReplication } from "./workspaceAttachmentReplication"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"
import type { BlobDescriptor } from "@meta-uber/mesh-blob"
import { getPrivateReplicaProgress } from "./privateReplicaRepository"
import { parseReplicaContentKeys } from "./replicaContentKeys"
import { selectWorkspaceAttachmentTransfer, type WorkspaceAttachmentTransfer } from "./workspaceAttachmentTransfers"
import type { RustyFetch } from "@meta-uber/mesh-replication/rusty-replica"

type AttachmentApp = Pick<ReturnType<typeof useTincanban>, "getCurrentProfile" | "readWorkspaceDoc">

/** The production background adapter retains private progress independently of the original source bytes. */
export function createWorkspaceAttachmentReplication(app: AttachmentApp, configInput: BlindReplicaConfig,
  ensureCurrent: () => void, flush: () => Promise<void>, report: (states: AttachmentCoverageStatus[]) => void,
  scopeFetch?: RustyFetch) {
  const config = structuredClone(configInput)
  const owner = app.getCurrentProfile()?.identity.personId
  if (!owner) throw new Error("Attachment identity is unavailable")
  const guardIdentity = () => {
    ensureCurrent()
    if (app.getCurrentProfile()?.identity.personId !== owner) throw new Error("Attachment identity changed")
  }
  const current = async () => {
    guardIdentity()
    await getPrivateReplicaProgress(owner, config)
    guardIdentity()
  }
  const index = createWorkspaceAttachmentIndex(owner, config, guardIdentity)
  const repository = async (descriptor: BlobDescriptor, context = config) => {
    const storageId = await blindHash(new TextEncoder().encode(canonicalBlindJson(["upload", attachmentIndexBinding(owner, context), descriptor])))
    guardIdentity()
    return createAttachmentRepository(storageId, guardIdentity)
  }
  const scope = { workspaceId: config.workspaceId, scopeId: config.scopeId, ...parseReplicaContentKeys(config) }
  const transfers = new Map<string, WorkspaceAttachmentTransfer>()
  const descriptorKey = (descriptor: BlobDescriptor) => canonicalBlindJson(descriptor)
  const selectTransfer = async (descriptor: BlobDescriptor) => {
    const selected = await selectWorkspaceAttachmentTransfer(config, Math.ceil(descriptor.size / BLOB_CHUNK_BYTES),
      context => repository(descriptor, context), current)
    transfers.set(descriptorKey(descriptor), selected)
    return selected
  }
  let coverageSupport: Promise<boolean> | undefined
  return new WorkspaceAttachmentReplication(config.workspaceId, {
    current,
    list: async () => { await current(); return listWorkspaceAttachments(await app.readWorkspaceDoc(config.workspaceId)) },
    locators: () => index.read(),
    guard: (descriptor, mode) => createAttachmentAccessGuard(app, config, descriptor, mode, guardIdentity),
    prepared: async descriptor => {
      return (await selectTransfer(descriptor)).prepared
    },
    local: readStoredAttachmentStream,
    upload: async (descriptor, source, guard) => {
      await current()
      const selected = transfers.get(descriptorKey(descriptor)) ?? await selectTransfer(descriptor)
      const context = { workspaceId: config.workspaceId, scopeId: config.scopeId, ...parseReplicaContentKeys(selected.config) }
      const transport = scopeFetch ? {
        upload: (access: Parameters<typeof uploadBlindBlob>[0], object: Parameters<typeof uploadBlindBlob>[1], requestId: string) =>
          uploadBlindBlob(access, object, requestId, scopeFetch),
        download: (access: Parameters<typeof downloadBlindBlob>[0], id: string) => downloadBlindBlob(access, id, scopeFetch),
      } : undefined
      return new AttachmentTransfer(context, config, selected.repository, guard, transport).uploadStream(descriptor, source)
    },
    confirm: async (descriptor, locator, guard) => { await confirmRustyAttachmentCoverage(scope, config, descriptor, locator, guard, scopeFetch) },
    publish: async locator => { await current(); await index.merge([locator]); await current() },
    flush,
    supportsCoverage: async () => {
      await current()
      const pending = coverageSupport ??= discoverBlindKeeper(config.origin).then(async discovery => {
        await current()
        if (discovery.servicePublicKey !== config.servicePublicKey) throw new Error("Rusty service identity changed. Reconnect explicitly.")
        return discovery.blobCoverage?.version === 1
      })
      try { const supported = await pending; if (!supported) coverageSupport = undefined; return supported }
      catch (cause) { coverageSupport = undefined; throw cause }
    },
    report: states => { guardIdentity(); report(states) },
  })
}
