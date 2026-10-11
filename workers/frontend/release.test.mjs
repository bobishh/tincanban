import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRelease, retainedAsset } from './release.mjs';

test('Given a repeated release tag, when CI publishes, then deploy the exact uploaded version rather than resolving the tag', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(new URL('../../.github/workflows/deploy-frontend.yml', import.meta.url), 'utf8');
  assert.match(workflow, /WRANGLER_OUTPUT_FILE_PATH="\$upload_output"/);
  assert.match(workflow, /release\.mjs uploaded-version "\$upload_output"/);
  assert.match(workflow, /versions deploy .*"\$version_id@100"/);
  assert.doesNotMatch(workflow, /--version-tag/);
});

test('Given a sealed build with Vite hidden manifest, when CI uploads dist, then include hidden files for deployment', async () => {
  const { readFileSync } = await import('node:fs');
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const artifactName = 'name: tincanban-frontend-${{ github.sha }}';
  const artifactIndex = workflow.indexOf(artifactName);
  assert.notEqual(artifactIndex, -1, 'frontend artifact upload step must exist');
  const uploadStepStart = workflow.lastIndexOf('      - uses: actions/upload-artifact@v6', artifactIndex);
  const nextStepStart = workflow.indexOf('\n      - ', artifactIndex);
  const uploadStep = workflow.slice(uploadStepStart, nextStepStart < 0 ? undefined : nextStepStart);
  assert.match(uploadStep, /path:\s*dist\//);
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
