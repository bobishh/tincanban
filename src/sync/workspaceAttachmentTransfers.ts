import type { BlindReplicaConfig } from "./blindReplication"
import type { AttachmentTransferRepository } from "./attachmentTransfer"
import { replicaContentKeyEntries } from "./replicaContentKeys"

export type WorkspaceAttachmentTransfer = {
  config: BlindReplicaConfig
  repository: AttachmentTransferRepository
  prepared: boolean
}

/** Resume original ciphertext after rotation; transport credentials always come from the current connection. */
export async function selectWorkspaceAttachmentTransfer(configInput: BlindReplicaConfig, chunkCount: number,
  open: (config: BlindReplicaConfig) => Promise<AttachmentTransferRepository>, guard: () => Promise<void>): Promise<WorkspaceAttachmentTransfer> {
  const config = structuredClone(configInput)
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 0 || chunkCount > 32) throw new Error("Invalid attachment chunk count")
  const candidates = replicaContentKeyEntries(config).sort(([left], [right]) => right - left)
    .map(([keyEpoch, contentKey]) => ({ ...config, keyEpoch, contentKey,
      historicalContentKeys: undefined, historicalContentKeyVariants: undefined }))
  let active: AttachmentTransferRepository | undefined
  for (const candidate of candidates) {
    await guard()
    const repository = await open(candidate)
    await guard()
    active ??= repository
    const progress = await repository.read()
    await guard()
    if (progress) return { config: candidate, repository, prepared: true }
    const preparation = await repository.preparation?.read()
    await guard()
    // A partial preparation also owns its original context. Source continuation must not discard its chunks.
    if (preparation) return { config: candidate, repository, prepared: preparation.chunks.length === chunkCount }
  }
  await guard()
  return { config, repository: active!, prepared: false }
}
