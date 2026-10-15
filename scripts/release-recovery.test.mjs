import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sealArtifact } from './release-cohort.mjs';
import { composeRollbackFrontend, selectCompatibleRollback, assertRecoveryRun } from './release-recovery.mjs';
const sha = 'a'.repeat(40), sdk = 'b'.repeat(40);
const file = (value) => Buffer.from(value);
const frontend = (candidateId, text, additional = {}) => {
  const files = { 'frontend.mjs': file('adapter'), 'wrangler.json': file('{}'),
    'assets/index.html': file(text), [`assets/assets/app-${text.repeat(8)}.js`]: file(text), ...additional };
  const { createHash } = process.getBuiltinModule('node:crypto');
  const hashes = Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith('assets/')).map(([path, bytes]) => [path.slice(7), createHash('sha256').update(bytes).digest('hex')]));
  files['assets/release.json'] = file(JSON.stringify({ sha, files: hashes }));
  return { artifact: sealArtifact({ component: 'frontend', sourceSha: sha, sdkSha: sdk, candidateId, readers: { privateReplicas: 4 }, writerVersion: 2 }, files), files };
};
test('Given rollback UI and tabs from the active UI, when composing an envelope, then keep old entry HTML and both exact lazy chunks', () => {
  const old = frontend('1-1', 'a'), active = frontend('2-1', 'c');
  const result = composeRollbackFrontend(old, active, 1000);
  assert.equal(result.files['assets/index.html'].toString(), 'a');
  assert.equal(result.files['assets/assets/app-cccccccc.js'].toString(), 'c');
  assert.deepEqual(result.artifact.derivedFrom, [old.artifact.artifactSha256, active.artifact.artifactSha256]);
  assert.equal(JSON.parse(result.files['assets/release.json']).retainedUntil['assets/app-cccccccc.js'], 1000 + 7 * 86400000);
});
test('Given retained chunks with an existing expiry, when rolling back again, then do not extend their lifetime', () => {
  const old = frontend('1-1', 'a'), active = frontend('2-1', 'c', { 'assets/assets/lazy-dddddddd.js': file('d') });
  const manifest = JSON.parse(active.files['assets/release.json']);
  manifest.retained = { 'assets/lazy-dddddddd.js': manifest.files['assets/lazy-dddddddd.js'] };
  delete manifest.files['assets/lazy-dddddddd.js']; manifest.retainedUntil = { 'assets/lazy-dddddddd.js': 2000 };
  active.files['assets/release.json'] = file(JSON.stringify(manifest));
  active.artifact = sealArtifact({ component: 'frontend', sourceSha: sha, sdkSha: sdk, candidateId: '2-1', readers: { privateReplicas: 4 }, writerVersion: 2 }, active.files);
  const result = composeRollbackFrontend(old, active, 1000);
  assert.equal(JSON.parse(result.files['assets/release.json']).retainedUntil['assets/lazy-dddddddd.js'], 2000);
});
test('Given older readers or writers, when choosing a rollback, then refuse without clearing retained data', () => {
  const current = { contract: { minimumWriterVersion: 2, readers: { frontend: { privateReplicas: 4 } } } };
  assert.throws(() => selectCompatibleRollback(current, { components: { frontend: { readers: { privateReplicas: 3 }, writerVersion: 2 } } }), /Incompatible rollback/);
  assert.throws(() => selectCompatibleRollback(current, { components: { frontend: { readers: { privateReplicas: 4 }, writerVersion: 1 } } }), /writer/);
});
test('Given an archive run, when recovering production, then reject PRs, forks, another workflow or a different attempt', () => {
  const run = { id: 42, run_attempt: 2, event: 'workflow_run', head_branch: 'main', path: '.github/workflows/deploy-frontend.yml', repository: { full_name: 'bobishh/tincanban' }, head_repository: { full_name: 'bobishh/tincanban' } };
  assert.doesNotThrow(() => assertRecoveryRun(run, 'bobishh/tincanban', '42', '2'));
  for (const update of [{ event: 'pull_request' }, { path: '.github/workflows/ci.yml' }, { run_attempt: 3 }, { head_repository: { full_name: 'someone/fork' } }]) assert.throws(() => assertRecoveryRun({ ...run, ...update }, 'bobishh/tincanban', '42', '2'), /trusted production/);
});
test('Given a required management action, when a prior release only advertised the older action set, then refuse before changing production', () => {
  const current = { contract: { minimumWriterVersion: 2, readers: {}, capabilities: { automation: { instanceManagement: { version: 1, actions: ['discover', 'rotate-storage'] } } } } };
  const target = { components: {}, contract: { capabilities: { automation: { instanceManagement: { version: 1, actions: ['discover'] } } } } };
  assert.throws(() => selectCompatibleRollback(current, target), /capability/);
});
test('Given an archived lazy chunk whose bytes changed, when composing rollback, then reject the envelope', () => {
  const old = frontend('1-1', 'a'), active = frontend('2-1', 'c');
  active.files['assets/assets/app-cccccccc.js'] = file('substituted');
  assert.throws(() => composeRollbackFrontend(old, active, 1000), /checksum/);
});
