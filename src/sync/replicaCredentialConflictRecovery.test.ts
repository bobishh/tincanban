import { expect, it } from 'vitest'
import { encodeBlindBytes } from './blindEnvelope'
import { changeReplicaPreference, emptyPrivateReplicaState, mergePrivateReplicaState, portableReplicaState } from './privateReplicaPreferences'
import { buildReplicaCredentialConflictRecovery } from './replicaCredentialConflictRecovery'
import { contentKeysForEpoch } from './replicaContentKeys'
const key = (byte: number) => encodeBlindBytes(new Uint8Array(32).fill(byte))
const config = { origin: 'https://rusty.example', scopeId: 'scope', workspaceId: 'board', servicePublicKey: key(7),
  readToken: key(8), writeToken: key(9), keyEpoch: 1, contentKey: key(1), policyRevision: 2, cursor: 0, lastUploaded: '' }
function conflicted() {
  const first = changeReplicaPreference(emptyPrivateReplicaState('person', 'first'), config)
  const second = changeReplicaPreference(emptyPrivateReplicaState('person', 'second'), { ...config, contentKey: key(2), readToken: key(10) })
  return portableReplicaState(mergePrivateReplicaState(first, portableReplicaState(second)))
}
const request = { origin: config.origin, scopeId: config.scopeId, servicePublicKey: config.servicePublicKey,
  expectedPolicyRevision: 9, freshContentKey: key(3), freshReadToken: key(4), freshWriteToken: key(5) }
it('Given incompatible same-epoch credentials, when an Owner proposes recovery, then preserve both keys, exact source evidence and every original binding', () => {
  const wire = conflicted(), before = structuredClone(wire)
  const proposal = buildReplicaCredentialConflictRecovery(wire, request)
  expect(proposal.next).toMatchObject({ keyEpoch: 2, contentKey: key(3), policyRevision: 10, cursor: 0, lastUploaded: '', minimumWriterVersion: 2 })
  expect(contentKeysForEpoch(proposal.next, 1)).toEqual([key(1), key(2)].sort())
  expect(proposal.previousVariants).toHaveLength(2)
  expect(proposal.sourceWire).toEqual(before)
  expect(wire).toEqual(before)
  expect(proposal.previousVariants.every(value => value.preferenceRevision)).toBe(true)
})
it('Given reused tokens or content keys, when proposing recovery, then refuse before policy mutation', () => {
  for (const changed of [{ freshContentKey: key(1) }, { freshReadToken: config.readToken }, { freshWriteToken: request.freshReadToken }]) {
    expect(() => buildReplicaCredentialConflictRecovery(conflicted(), { ...request, ...changed })).toThrow(/fresh|reuse|key/i)
  }
})
it('Given an entry without a conflict or an unrelated resource, when proposing recovery, then refuse instead of silently rotating it', () => {
  expect(() => buildReplicaCredentialConflictRecovery(portableReplicaState(changeReplicaPreference(emptyPrivateReplicaState('person', 'first'), config)), request)).toThrow(/conflict/i)
  expect(() => buildReplicaCredentialConflictRecovery(conflicted(), { ...request, scopeId: 'different' })).toThrow(/scope|conflict/i)
})
it('Given an original outbox binding no longer present among maximal variants, when proposing recovery, then retain its key as well', () => {
  const extra = { ...config, contentKey: key(11), preferenceRevision: 'retained:1' }
  const proposal = buildReplicaCredentialConflictRecovery(conflicted(), { ...request, extraRetainedConfigs: [extra] })
  expect(contentKeysForEpoch(proposal.next, 1)).toEqual([key(1), key(2), key(11)].sort())
  expect(proposal.previousVariants).toContainEqual({ ...extra, purpose: 'workspace' })
})
it('Given a discovered replacement service pin, when proposing key recovery, then require explicit pin review instead of repinning or sending fresh secrets', () => {
  expect(() => buildReplicaCredentialConflictRecovery(conflicted(), { ...request, servicePublicKey: key(21) })).toThrow(/pin|service/i)
})
