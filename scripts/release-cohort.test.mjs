import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealArtifact, verifyArtifact, assertCompatibleRollback } from './release-cohort.mjs';

const artifact = (component = 'frontend', readers = { privateReplicas: 5 }) => sealArtifact({
  component, sourceSha: 'a'.repeat(40), sdkSha: 'b'.repeat(40), candidateId: '42-1', readers, writerVersion: 2,
}, { 'entry.js': Buffer.from('sealed bytes') });

test('component artifacts bind checked bytes and reject changed or extra files', () => {
  const value = artifact();
  assert.equal(verifyArtifact(value, { 'entry.js': Buffer.from('sealed bytes') }).artifactSha256, value.artifactSha256);
  assert.throws(() => verifyArtifact(value, { 'entry.js': Buffer.from('changed') }), /checksum/);
  assert.throws(() => verifyArtifact(value, { 'entry.js': Buffer.from('sealed bytes'), 'extra.js': Buffer.from('unsealed') }), /file set/);
});

test('component rollback checks stay local to that component reader contract', () => {
  assert.throws(() => assertCompatibleRollback({ readers: { privateReplicas: 4 } }, { privateReplicas: 5 }), /rollback reader/);
  assert.doesNotThrow(() => assertCompatibleRollback({ readers: { privateReplicas: 5 } }, { privateReplicas: 5 }));
});
