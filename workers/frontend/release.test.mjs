import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRelease, retainedAsset, retentionCandidates } from './release.mjs';

test('Given several deployments while a tab stays open, when retaining assets, then keep its chunks for seven days without renewing their expiry', () => {
  const now = Date.parse('2026-10-11T18:00:00Z');
  const hash = 'a'.repeat(64);
  const previous = {
    files: { 'assets/current-Abc12345.js': hash, 'index.html': hash },
    retained: { 'assets/old-Abc12345.css': hash, 'assets/expired-Abc12345.js': hash },
    retainedUntil: { 'assets/old-Abc12345.css': now + 1000, 'assets/expired-Abc12345.js': now - 1 },
  };
  const candidates = retentionCandidates(previous, now);
  assert.deepEqual(candidates, [
    ['assets/old-Abc12345.css', hash, now + 1000],
    ['assets/current-Abc12345.js', hash, now + 7 * 24 * 60 * 60 * 1000],
  ]);
  assert.equal(retentionCandidates({ retained: { '../private': hash }, files: {} }, now).length, 0);
});

test('Given more than 2,000 legitimate chunks, when retaining a busy release week, then preserve every live chunk and discard expired or unrelated entries', () => {
  const now = Date.parse('2026-10-16T16:00:00Z');
  const hash = 'a'.repeat(64);
  const retained = Object.fromEntries(Array.from({ length: 2100 }, (_, index) => [`assets/chunk-${String(index).padStart(8, '0')}.js`, hash]));
  const retainedUntil = Object.fromEntries(Object.keys(retained).map(path => [path, now + 1000]));
  const candidates = retentionCandidates({ files: { 'index.html': hash }, retained: { ...retained, 'assets/expired-Abc12345.js': hash },
    retainedUntil: { ...retainedUntil, 'assets/expired-Abc12345.js': now - 1 } }, now);
  assert.equal(candidates.length, 2100);
  assert.ok(candidates.every(([path, checksum, until]) => path in retained && checksum === hash && until === now + 1000));
});

test('Given live chunks exceed reserved capacity, when retaining assets, then fail without silently evicting open-tab chunks', () => {
  const hash = 'a'.repeat(64);
  const files = Object.fromEntries(Array.from({ length: 10_001 }, (_, index) => [`assets/chunk-${String(index).padStart(8, '0')}.js`, hash]));
  assert.throws(() => retentionCandidates({ files }), /retention capacity/);
});

test('Given a repeated release tag, when CI publishes, then deploy exact uploaded frontend version without bundling a Worker', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(new URL('../../.github/workflows/deploy-frontend.yml', import.meta.url), 'utf8');
  assert.match(workflow, /WRANGLER_OUTPUT_FILE_PATH="\$output"/);
  assert.match(workflow, /release\.mjs uploaded-version/);
  assert.match(workflow, /"\$version@100"/);
  assert.doesNotMatch(workflow, /--version-tag/);
  assert.match(workflow, /prepare frontend/);
  assert.doesNotMatch(workflow, /automation/);
});

test('Given a sealed build with Vite hidden manifest, when CI uploads dist, then include hidden files for deployment', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const artifactName = 'name: tincanban-frontend-cohort-${{ github.sha }}';
  const artifactIndex = workflow.indexOf(artifactName);
  assert.notEqual(artifactIndex, -1, 'frontend artifact upload step must exist');
  const uploadStepStart = workflow.lastIndexOf('      - uses: actions/upload-artifact@v6', artifactIndex);
  const nextStepStart = workflow.indexOf('\n      - ', artifactIndex);
  const uploadStep = workflow.slice(uploadStepStart, nextStepStart < 0 ? undefined : nextStepStart);
  assert.match(uploadStep, /path:\s*\.release\/frontend\//);
  assert.match(uploadStep, /include-hidden-files:\s*true/);
});

test('Given structured upload output, when selecting the version, then require exactly one successful version UUID', async () => {
  const { uploadedVersion } = await import('./release.mjs');
  const versionId = 'e7cb6b89-34e9-4103-8729-d8b55a88e901';
  const session = JSON.stringify({ type: 'wrangler-session', version: 1 });
  const upload = JSON.stringify({ type: 'version-upload', version: 1, version_id: versionId });
  assert.equal(uploadedVersion(`${session}\n${upload}\n`), versionId);
  for (const output of [session, `${upload}\n${upload}`, JSON.stringify({ type: 'version-upload', version_id: null }), JSON.stringify({ type: 'version-upload', version_id: 'tag@100' }), 'invalid JSON']) {
    assert.throws(() => uploadedVersion(output));
  }
});

test('Given a checked artifact, when SHA or bytes differ, then refuse deployment', () => {
  const file = Buffer.from('built');
  const manifest = { sha: 'a'.repeat(40), files: { 'index.html': 'wrong' } };
  assert.throws(() => checkRelease(manifest, 'b'.repeat(40), () => file), /commit/);
  assert.throws(() => checkRelease(manifest, 'a'.repeat(40), () => file), /checksum/);
});
test('Given old assets, retain only fingerprinted chunks inside assets', () => {
  assert.equal(retainedAsset('assets/Board-Abc12345.js'), true);
  for (const path of ['../private', 'index.html', 'assets/../../secret-Abc12345.js', 'assets/config.js']) assert.equal(retainedAsset(path), false);
});

test('Given matching build bytes and SHA, then accept; reject unsafe manifest paths', async () => {
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('built');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const sha = 'a'.repeat(40);
  assert.doesNotThrow(() => checkRelease({ sha, files: { 'index.html': hash } }, sha, () => bytes));
  assert.throws(() => checkRelease({ sha, files: { 'index.html': hash, '../secret': hash } }, sha, () => bytes), /checksum/);
});
