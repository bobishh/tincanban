import { canonicalizeJson } from '../domain/identity'
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { buildReplicaCredentialConflictRecovery, type ReplicaCredentialConflictRecoveryProposal } from './replicaCredentialConflictRecovery'

export type ReplicaCredentialConflictFreeze = {
  kind: 'rusty-credential-conflict-freeze'
  version: 2
  id: string
  personId: string
  signerDeviceId: string
  origin: string
  scopeId: string
  proposal: ReplicaCredentialConflictRecoveryProposal
}
function assertFreezeHeader(value: ReplicaCredentialConflictFreeze, personId: string, origin: string) {
  if (!value || Object.keys(value).some(key => !['kind', 'version', 'id', 'personId', 'signerDeviceId', 'origin', 'scopeId', 'proposal'].includes(key)) ||
      value.kind !== 'rusty-credential-conflict-freeze' || value.version !== 2 || value.personId !== personId || value.origin !== blindOrigin(origin) ||
      !/^[0-9a-f-]{36}$/i.test(value.id) || typeof value.signerDeviceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.signerDeviceId))
    throw new Error('Invalid credential conflict recovery freeze')
}
/** Strict separate format. A v1 single-effective-credential transition must never accept this record. */
export function parseReplicaCredentialConflictFreeze(input: unknown, personId: string, origin: string): ReplicaCredentialConflictFreeze {
  const encoded = typeof input === 'string' ? input : JSON.stringify(input)
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > 4 * 1024 * 1024) throw new Error('Credential conflict freeze exceeds storage bound')
  const value = structuredClone(JSON.parse(encoded)) as ReplicaCredentialConflictFreeze
  assertFreezeHeader(value, personId, origin)
  const proposal = value.proposal, next = proposal?.next
  if (!proposal || !next || next.origin !== value.origin || next.scopeId !== value.scopeId || proposal.personId !== personId) throw new Error('Recovery freeze resource binding changed')
  const expected = buildReplicaCredentialConflictRecovery(proposal.sourceWire, { origin: value.origin, scopeId: value.scopeId,
    servicePublicKey: next.servicePublicKey, expectedPolicyRevision: proposal.expectedPolicyRevision,
    freshContentKey: next.contentKey, freshReadToken: next.readToken, freshWriteToken: next.writeToken,
    extraRetainedConfigs: proposal.previousVariants })
  if (canonicalizeJson(expected) !== canonicalizeJson(proposal)) throw new Error('Recovery freeze dropped or changed original credential evidence')
  return value
}
