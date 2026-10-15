import { expect, it } from 'vitest'
import { encodeBlindBytes } from './blindEnvelope'
import { changeReplicaPreference, emptyPrivateReplicaState, mergePrivateReplicaState, portableReplicaState } from './privateReplicaPreferences'
import { buildReplicaCredentialConflictRecovery } from './replicaCredentialConflictRecovery'
import { parseReplicaCredentialConflictFreeze, type ReplicaCredentialConflictFreeze } from './replicaCredentialConflictFreeze'
const key = (byte: number) => encodeBlindBytes(new Uint8Array(32).fill(byte))
function fixture(): ReplicaCredentialConflictFreeze {
  const config = { origin: 'https://rusty.example', scopeId: 'scope', workspaceId: 'board', servicePublicKey: key(7),
    readToken: key(8), writeToken: key(9), keyEpoch: 1, contentKey: key(1), policyRevision: 2, cursor: 0, lastUploaded: '' }
  const a = changeReplicaPreference(emptyPrivateReplicaState('person', 'first'), config)
  const b = changeReplicaPreference(emptyPrivateReplicaState('person', 'second'), { ...config, contentKey: key(2) })
  const wire = portableReplicaState(mergePrivateReplicaState(a, portableReplicaState(b)))
  return { kind: 'rusty-credential-conflict-freeze', version: 2, id: '01234567-89ab-cdef-0123-456789abcdef', personId: 'person', signerDeviceId: 'device',
    origin: config.origin, scopeId: config.scopeId, proposal: buildReplicaCredentialConflictRecovery(wire, { origin: config.origin, scopeId: config.scopeId,
      servicePublicKey: config.servicePublicKey, expectedPolicyRevision: 2, freshContentKey: key(3), freshReadToken: key(4), freshWriteToken: key(5) }) }
}
it('Given an interrupted conflict recovery, when strict freeze evidence is restored, then preserve both original keys and the exact causal source', () => {
  const original = fixture()
  expect(parseReplicaCredentialConflictFreeze(JSON.stringify(original), 'person', original.origin)).toEqual(original)
})
it('Given a saved recovery that lost an old candidate or changed identity/scope, when loading, then fail before any remote policy write', () => {
  const original = fixture()
  const lost = structuredClone(original)
  lost.proposal.next.historicalContentKeyVariants!['1'] = [key(1), key(6)].sort()
  for (const candidate of [lost, { ...original, personId: 'other' }, { ...original, scopeId: 'different' }, { ...original, version: 1 }]) {
    expect(() => parseReplicaCredentialConflictFreeze(candidate, 'person', original.origin)).toThrow()
  }
})
