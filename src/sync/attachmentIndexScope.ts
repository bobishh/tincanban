import type { BlindReplicaConfig } from "./blindReplication"
import { privateReplicaBinding } from "./privateReplicaBinding"
import { createAttachmentIndexRepository, planAttachmentIndexMigration } from "./attachmentIndexRepository"
import { parseReplicaConfig } from "./blindReplicaConfig"
import { canonicalBlindJson } from "./blindClient"
import type { AttachmentLocator } from "./attachmentCodec"
import { replicaContentKeyEntries } from "./replicaContentKeys"
import type { LocalStatePlan } from "../localDb"

/** File discovery follows the encryption context, independently of replaceable access tokens and local cursors. */
export function attachmentIndexBinding(owner: string, config: BlindReplicaConfig): string {
  if (typeof owner !== "string" || !owner || owner.length > 128) throw new Error("Invalid attachment index owner")
  const checked = parseReplicaConfig(JSON.stringify(config))
  return canonicalBlindJson([2, owner, checked.workspaceId, checked.origin, checked.scopeId, checked.keyEpoch,
    checked.servicePublicKey, checked.contentKey])
}

export function createWorkspaceAttachmentIndex(owner: string, config: BlindReplicaConfig, ensureCurrent: () => void) {
  ensureCurrent()
  const captured = parseReplicaConfig(JSON.stringify(config))
  const current = createAttachmentIndexRepository(attachmentIndexBinding(owner, captured), ensureCurrent)
  // Key-history configurations require the newer reader; no legacy preference-bound index existed for them.
  const legacy = captured.historicalContentKeys || captured.historicalContentKeyVariants ? undefined : createAttachmentIndexRepository(privateReplicaBinding(owner, captured), ensureCurrent)
  const retained = replicaContentKeyEntries(captured).filter(([epoch]) => epoch !== captured.keyEpoch).map(([keyEpoch, contentKey]) =>
    createAttachmentIndexRepository(attachmentIndexBinding(owner, { ...captured, keyEpoch, contentKey,
      historicalContentKeys: undefined, historicalContentKeyVariants: undefined }), ensureCurrent))
  const copiedRevisions = new Map<number, string | undefined>()
  let migrating: Promise<void> | undefined
  const migrateLegacy = async () => {
    if (!migrating) migrating = (async () => {
      const sources = legacy ? [legacy, ...retained] : retained
      for (const [index, source] of sources.entries()) {
        const revision = await source.revision()
        if (copiedRevisions.has(index) && revision === copiedRevisions.get(index)) continue
        const locators = await source.read()
        await current.merge(locators)
        ensureCurrent()
        copiedRevisions.set(index, revision)
      }
    })().finally(() => { migrating = undefined })
    await migrating
    ensureCurrent()
  }
  return {
    async read(): Promise<AttachmentLocator[]> { await migrateLegacy(); return current.read() },
    async revision(): Promise<string | undefined> { await migrateLegacy(); return current.revision() },
    async merge(locators: unknown): Promise<void> { await migrateLegacy(); await current.merge(locators) },
  }
}

/** Plan an additive legacy-index migration for one exact workspace encryption context. */
export async function planWorkspaceAttachmentIndexMigration(owner: string, config: BlindReplicaConfig): Promise<LocalStatePlan> {
  const captured = parseReplicaConfig(JSON.stringify(config))
  if (captured.historicalContentKeys || captured.historicalContentKeyVariants) return { conditions: [], writes: [] }
  return planAttachmentIndexMigration(privateReplicaBinding(owner, captured), attachmentIndexBinding(owner, captured))
}
