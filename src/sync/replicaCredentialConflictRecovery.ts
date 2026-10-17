import { canonicalizeJson } from '../domain/identity'
import type { PrivateReplicaConfig } from './blindReplication'
import { parsePrivateReplicaConfig } from './blindReplicaConfig'
import { decodeBlindBytes, encodeBlindBytes } from './blindEnvelope'
import { blindOrigin } from './blindOrigin'
import { mergeReplicaContentKeyVariants, replicaContentKeyEntries } from './replicaContentKeys'
import { parsePrivateReplicaWire, type PrivateReplicaWire } from './privateReplicaPreferences'

export type ReplicaCredentialConflictRecoveryRequest = {
  origin: string
  scopeId: string
  servicePublicKey: string
  expectedPolicyRevision: number
  freshContentKey: string
  freshReadToken: string
  freshWriteToken: string
  extraRetainedConfigs?: PrivateReplicaConfig[]
}
export type ReplicaCredentialConflictRecoveryProposal = {
  kind: 'rusty-credential-conflict-recovery'
  version: 1
  personId: string
  sourceWire: PrivateReplicaWire
  sourceRevision: string
  expectedPolicyRevision: number
  previousVariants: PrivateReplicaConfig[]
  next: PrivateReplicaConfig
}
function freshSecret(value: string): string {
  const bytes = decodeBlindBytes(value)
  if (bytes.byteLength !== 32 || encodeBlindBytes(bytes) !== value) throw new Error('Fresh recovery secrets must be canonical 32-byte values')
  return value
}
/** A pure proposal. The controller must freeze/drain original outboxes, verify live Owner authority and perform signed policy CAS before activation. */
export function buildReplicaCredentialConflictRecovery(input: unknown,
  requestInput: ReplicaCredentialConflictRecoveryRequest): ReplicaCredentialConflictRecoveryProposal {
  const sourceWire = parsePrivateReplicaWire(structuredClone(input)), request = structuredClone(requestInput)
  const origin = blindOrigin(request.origin)
  const entry = sourceWire.entries.find(value => value.origin === origin && value.scopeId === request.scopeId)
  // Retained journals may predate the policy-only join. Resume their exact frozen proposal;
  // new recovery captures still require an unresolved repository conflict.
  if (!entry || new Set(entry.operations.map(operation => canonicalizeJson(operation.config))).size < 2) {
    throw new Error('Exact conflicting Rusty scope is required for recovery')
  }
  if (entry.operations.some(operation => !operation.config || operation.config.removalPending)) throw new Error('A removed connection cannot be resurrected by credential conflict recovery')
  const previousVariants = entry.operations.map(operation => ({ ...structuredClone(operation.config!),
    preferenceRevision: `${operation.dot.actorId}:${operation.dot.counter}` }))
  const retained = [...previousVariants, ...(request.extraRetainedConfigs ?? []).map(config => parsePrivateReplicaConfig(JSON.stringify(config), sourceWire.personId))]
  if (retained.some(config => config.servicePublicKey !== request.servicePublicKey)) throw new Error("Rusty service pin changed; explicit pinned-authority review is required before credential recovery")
  if (retained.length > 64 || retained.some(config => config.origin !== origin || config.scopeId !== request.scopeId)) throw new Error("Retained original progress belongs to another recovery scope")
  const subjects = new Set(retained.map(config => canonicalizeJson([config.purpose,
    config.purpose === 'identity' ? config.personId : config.workspaceId])))
  if (subjects.size !== 1) throw new Error('Conflicting resource identities require explicit scope review before key recovery')
  if (!Number.isSafeInteger(request.expectedPolicyRevision) || request.expectedPolicyRevision < 1 || request.expectedPolicyRevision === Number.MAX_SAFE_INTEGER) throw new Error('Current signed scope policy revision is required')
  const contentKey = freshSecret(request.freshContentKey), readToken = freshSecret(request.freshReadToken), writeToken = freshSecret(request.freshWriteToken)
  const used = new Set(retained.flatMap(config => [config.readToken, config.writeToken, ...replicaContentKeyEntries(config).map(([, key]) => key)]))
  if (new Set([contentKey, readToken, writeToken]).size !== 3 || [contentKey, readToken, writeToken].some(value => used.has(value))) throw new Error('Recovery must use fresh independent keys and tokens without reuse')
  const keys = mergeReplicaContentKeyVariants(retained, contentKey)
  const subject = previousVariants[0]!
  const binding = subject.purpose === 'identity' ? { purpose: 'identity' as const, personId: subject.personId }
    : { purpose: 'workspace' as const, workspaceId: subject.workspaceId, minimumWriterVersion: 2 as const }
  const next = parsePrivateReplicaConfig(JSON.stringify({ ...binding, origin, scopeId: request.scopeId,
    servicePublicKey: request.servicePublicKey, ...keys, readToken, writeToken,
    policyRevision: request.expectedPolicyRevision + 1, cursor: 0, lastUploaded: '' }), sourceWire.personId)
  return { kind: 'rusty-credential-conflict-recovery', version: 1, personId: sourceWire.personId, sourceWire,
    sourceRevision: canonicalizeJson([sourceWire.personId, sourceWire.clock, entry]), expectedPolicyRevision: request.expectedPolicyRevision,
    previousVariants: [...new Map(retained.map(config => [canonicalizeJson(config), config])).values()], next }
}
