import { listLocalKeys, readLocal } from "../localDb"
import { toBase64Url } from "../domain/identity"
import type { StoredReceivedHistoryBaseline } from "../storageJournal"
import type { PrivateReplicaConfig } from "./blindReplication"
import { contentKeysForEpoch } from "./replicaContentKeys"
import { isPlainRecord, parseState, stateKey } from "./privateReplicaRepositoryState"
import { listRetainedWorkspaceRecoveryArchives } from "./workspaceHistoryRecoveryArchives"

function matchingKeys(configs: PrivateReplicaConfig[], active: StoredReceivedHistoryBaseline): string[] {
  return configs.filter(config => config.purpose !== "identity" && config.workspaceId === active.workspaceId &&
    config.scopeId === active.scopeId && config.servicePublicKey === active.pinnedStorage.servicePublicKey)
    .flatMap(config => { try { return contentKeysForEpoch(config, active.keyEpoch) } catch { return [] } })
}

/** Reading material only. Removed delivery credentials are never reactivated or returned. */
export async function readHistoryBaselineKeyCandidates(owner: string, active: StoredReceivedHistoryBaseline,
  configurations: PrivateReplicaConfig[], ensureCurrent: () => void): Promise<string[]> {
  const keys = matchingKeys(configurations, active)
  const retained = await listRetainedWorkspaceRecoveryArchives(owner, active.workspaceId, ensureCurrent)
  const signedJson = toBase64Url(active.signedJson)
  keys.push(...retained.filter(({ source }) => source.scopeId === active.scopeId && source.keyEpoch === active.keyEpoch &&
    source.signedJson === signedJson).map(({ source }) => source.key))
  if (keys.length) return [...new Set(keys)]

  // Forget already preserved exact pre-removal settings. Read those originals without restoring network access.
  for (const key of await listLocalKeys()) {
    ensureCurrent()
    if (!key.startsWith("tincanban.rusty-local-reset.v1.")) continue
    const raw = await readLocal(key)
    ensureCurrent()
    if (raw === null) continue
    keys.push(...matchingKeys(auditConfigurations(raw, owner), active))
  }
  ensureCurrent()
  return [...new Set(keys)]
}

function auditConfigurations(raw: string, owner: string): PrivateReplicaConfig[] {
  let audit: unknown
  try { audit = JSON.parse(raw) } catch { return [] }
  if (!isPlainRecord(audit) || audit.version !== 1 || audit.personId !== owner ||
      typeof audit.origin !== "string" || !Array.isArray(audit.records)) return []
  const configurations: PrivateReplicaConfig[] = []
  for (const record of audit.records as unknown[]) {
    if (!isPlainRecord(record) || record.key !== stateKey(owner) || typeof record.value !== "string") continue
    let state: ReturnType<typeof parseState>
    try { state = parseState(record.value, owner) } catch { continue }
    configurations.push(...state.entries.filter(entry => entry.origin === audit.origin)
      .flatMap(entry => entry.operations.flatMap(operation => operation.config ? [operation.config] : [])))
  }
  return configurations
}
