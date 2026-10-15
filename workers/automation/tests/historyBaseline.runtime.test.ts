import { test } from 'vitest';
import assert from 'node:assert/strict';
import { inspectWorkerHistoryRouting } from '../src/historyBaseline.ts';
import { toBase64Url } from '../../../src/domain/identity.ts';
const key = (byte: number) => toBase64Url(new Uint8Array(32).fill(byte));
const storage = { origin: 'https://rusty.example', scopeId: 'scope', workspaceId: 'board', servicePublicKey: key(8),
  keyEpoch: 2, contentKey: key(2), historicalContentKeys: { '1': key(1) }, readToken: key(3), writeToken: key(4), policyRevision: 5, cursor: 0, lastUploaded: '' };
function wire(changes: Record<string, unknown> = {}) {
  const payload = { workspaceId: 'board', storage: { keyEpoch: 1, authority: { scopeId: 'scope', servicePublicKey: storage.servicePublicKey, policyRevision: 3 } }, ...changes };
  return { version: 1, signedJson: toBase64Url(new TextEncoder().encode(JSON.stringify({ payload }))), basis: {
    context: { workspaceId: 'board', historyEpoch: 1, indexId: 'basis-document' },
    reference: { kind: 'workspace-history-bytes', version: 1, root: { objectId: key(9), height: 0, count: 0, first: null, last: null }, byteLength: 0, partCount: 0 },
    locatorRoot: { kind: 'workspace-history-locator-root', version: 1, context: { workspaceId: 'board', historyEpoch: 1, indexId: 'archive-locators' },
      root: { objectId: key(9), ciphertextId: key(10), height: 0, count: 0, first: null, last: null } },
    coverage: { payload: { kind: 'blind-archive-coverage-aggregate-receipt', version: 1, serviceId: key(8), scopeId: 'scope',
      policyRevision: 3, requestId: 'routing-only-fixture-1234', archiveRootId: key(10), height: 1, objectCount: 1,
      firstObjectId: key(10), lastObjectId: key(10), setDigest: key(11), rootCovered: true }, signerKeyId: key(8),
      signature: toBase64Url(new Uint8Array(64)) } } };
}
test('Given retained old keys and a signed baseline routing claim, when reading its route, then use the claimed historical epoch without trusting its Owner', () => {
  const result = inspectWorkerHistoryRouting(wire(), 'board', storage);
  assert.equal(result.keyEpoch, 1);
  assert.equal(result.pinnedStorage.policyRevision, 3);
  assert.equal('owner' in result, false);
});
test('Given another scope/service/workspace or a future revision, when receiving history routing, then refuse before fetching archive bytes', () => {
  for (const update of [{ workspaceId: 'other' }, { storage: { keyEpoch: 1, authority: { scopeId: 'other', servicePublicKey: storage.servicePublicKey, policyRevision: 3 } } },
    { storage: { keyEpoch: 1, authority: { scopeId: 'scope', servicePublicKey: key(9), policyRevision: 3 } } },
    { storage: { keyEpoch: 3, authority: { scopeId: 'scope', servicePublicKey: storage.servicePublicKey, policyRevision: 3 } } },
    { storage: { keyEpoch: 1, authority: { scopeId: 'scope', servicePublicKey: storage.servicePublicKey, policyRevision: 6 } } }]) {
    assert.throws(() => inspectWorkerHistoryRouting(wire(update), 'board', storage));
  }
});

test('Given missing compact-basis durability evidence, when parsing Worker history, then refuse before archive reads or local replacement', () => {
  const value = wire();
  const missing = structuredClone(value) as { basis: { coverage?: unknown } };
  delete missing.basis.coverage;
  assert.throws(() => inspectWorkerHistoryRouting(missing, 'board', storage), /update|baseline|routing|coverage/i);
});
