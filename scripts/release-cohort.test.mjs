import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealArtifact, verifyArtifact, assembleCohort, assertCompatibleRollback, verifyComponentObservation } from './release-cohort.mjs';

const sha = 'a'.repeat(40);
const sdk = 'b'.repeat(40);
const readers = { identityDevice: 1, privateReplicas: 4, automationState: 3, workspaceSnapshot: 1 };
const artifact = (component, bytes = 'checked bundle') => sealArtifact({ component, sourceSha: sha, sdkSha: sdk,
  candidateId: 'run-42-1', readers, writerVersion: 2, ...(component === 'rusty' ? {
    image: `ghcr.io/bobishh/rusty@sha256:${'c'.repeat(64)}`, binarySha256: 'd'.repeat(64) } : {}) }, { 'index.js': Buffer.from(bytes) });

test('Given identical source revisions but different checked bytes, when sealing artifacts, then their identities differ', () => {
  assert.notEqual(artifact('automation', 'first').artifactSha256, artifact('automation', 'second').artifactSha256);
});
test('Given a sealed bundle, when a file changes or an unsealed module appears, then refuse upload', () => {
  const sealed = artifact('automation');
  assert.throws(() => verifyArtifact(sealed, { 'index.js': Buffer.from('changed') }), /checksum/);
  assert.throws(() => verifyArtifact(sealed, { 'index.js': Buffer.from('checked bundle'), 'extra.js': Buffer.from('unverified') }), /file set/);
});
test('Given checked components with incompatible schema readers, when assembling a cohort, then prevent activation', () => {
  const frontend = artifact('frontend');
  const automation = artifact('automation');
  const rusty = artifact('rusty');
  assert.throws(() => assembleCohort({ frontend, automation, rusty }, { version: 1, readers: {
    frontend: { ...readers, privateReplicas: 5 }, automation: readers, rusty: readers },
    minimumWriterVersion: 2, capabilities: {}, migrations: [], rollbackReaders: [frontend] }), /reader/);
});
test('Given a migrated retained schema, when selecting a rollback reader, then reject a reader that would discard that evidence', () => {
  assert.throws(() => assertCompatibleRollback({ ...artifact('frontend'), readers: { ...readers, privateReplicas: 3 } }, readers), /rollback reader/);
  assert.doesNotThrow(() => assertCompatibleRollback(artifact('frontend'), readers));
});
test('Given green CI and a matching source SHA, when a deployed component reports another artifact, then release stays incomplete', () => {
  const expected = artifact('automation');
  assert.throws(() => verifyComponentObservation(expected, { status: 'ready', buildSha: sha, artifactSha256: 'e'.repeat(64) }), /artifact/);
});
