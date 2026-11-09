import { canonicalizeJson } from "../domain/identity"
import type { PrivateReplicaConfig } from "./blindReplication"

/** Match installed access while ignoring replica progress. */
export function privateReplicaConfigurationKey(config: PrivateReplicaConfig): string {
  const { cursor, lastUploaded, ...credentials } = config
  void cursor; void lastUploaded
  return canonicalizeJson(credentials)
}

export function privateReplicaOperationKey(owner: string, epoch: number | null, config: PrivateReplicaConfig): string {
  return canonicalizeJson([owner, epoch, privateReplicaConfigurationKey(config)])
}

/** Stable serialization of the exact private replica credential binding. */
export function privateReplicaBinding(owner: string, config: PrivateReplicaConfig): string {
  const identity = config.purpose === "identity"
  const purpose = identity ? "identity" : "workspace"
  const subject = identity ? config.personId : config.workspaceId
  if (identity && config.purpose === "identity" && config.personId !== owner) throw new Error("Private Rusty identity mismatch")
  const fields: unknown[] = [owner, purpose, subject, config.origin, config.scopeId, config.keyEpoch, config.policyRevision,
    config.servicePublicKey, config.readToken, config.writeToken, config.contentKey, config.preferenceRevision]
  if (config.historicalContentKeys) fields.push({ historicalContentKeys: config.historicalContentKeys })
  if (config.historicalContentKeyVariants) fields.push({ historicalContentKeyVariants: config.historicalContentKeyVariants })
  return canonicalizeJson(fields)
}
