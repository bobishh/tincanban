import type { useTincanban } from "../state"
import { readStoredAttachmentStream } from "../attachments"
import { BLOB_CHUNK_BYTES } from "@meta-uber/mesh-blob"
import { blindHash, canonicalBlindJson, discoverBlindKeeper } from "./blindClient"
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

type AttachmentApp = Pick<ReturnType<typeof useTincanban>, "getCurrentProfile" | "readWorkspaceDoc">

/** The production background adapter retains private progress independently of the original source bytes. */
export function createWorkspaceAttachmentReplication(app: AttachmentApp, configInput: BlindReplicaConfig,
  ensureCurrent: () => void, flush: () => Promise<void>, report: (states: AttachmentCoverageStatus[]) => void) {
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
  const repository = async (descriptor: BlobDescriptor) => {
    const storageId = await blindHash(new TextEncoder().encode(canonicalBlindJson(["upload", attachmentIndexBinding(owner, config), descriptor])))
    guardIdentity()
    return createAttachmentRepository(storageId, guardIdentity)
  }
  const scope = { workspaceId: config.workspaceId, scopeId: config.scopeId, keyEpoch: config.keyEpoch, contentKey: config.contentKey }
  let coverageSupport: Promise<boolean> | undefined
  return new WorkspaceAttachmentReplication(config.workspaceId, {
    current,
    list: async () => { await current(); return listWorkspaceAttachments(await app.readWorkspaceDoc(config.workspaceId)) },
    locators: () => index.read(),
    guard: (descriptor, mode) => createAttachmentAccessGuard(app, config, descriptor, mode, guardIdentity),
    prepared: async descriptor => {
      const stored = await repository(descriptor)
      if (await stored.read()) return true
      const pending = await stored.preparation!.read()
      return pending?.chunks.length === Math.ceil(descriptor.size / BLOB_CHUNK_BYTES)
    },
    local: readStoredAttachmentStream,
    upload: async (descriptor, source, guard) => new AttachmentTransfer(scope, config, await repository(descriptor), guard).uploadStream(descriptor, source),
    confirm: async (descriptor, locator, guard) => { await confirmRustyAttachmentCoverage(scope, config, descriptor, locator, guard) },
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
