import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertActiveCompatibility, composeFrontendRollback, frontendReleaseMetadata, prepareComponent, readVerifiedReleaseAsset } from './component-release.mjs';
import { readArtifactFiles, sealArtifact } from './release-cohort.mjs';

const artifact = { component: 'frontend', sourceSha: 'a'.repeat(40), candidateId: '123-2', artifactSha256: 'b'.repeat(64),
  readers: { privateReplicas: 5 }, writerVersion: 2 };
const listFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? listFiles(path) : [path];
});

test('frontend compatibility metadata stays on the legacy frontend-only contract', () => {
  const value = frontendReleaseMetadata(artifact);
  assert.equal(value.kind, 'tincanban-release-cohort');
  assert.ok(/^[a-f0-9]{64}$/.test(value.cohortId));
  assert.deepEqual(Object.keys(value.components), ['frontend']);
  assert.deepEqual(Object.keys(value.contract.readers), ['frontend']);
});

test('frontend byte verification accepts canonical same-origin hosting redirects and exact bytes', async () => {
  const bytes = Buffer.from('checked html');
  const { createHash } = await import('node:crypto');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push([String(url), options.redirect]);
    if (String(url).endsWith('/index.html')) return { status: 308, headers: new Headers({ location: '/' }) };
    return { status: 200, ok: true, arrayBuffer: async () => bytes };
  };
  assert.deepEqual(await readVerifiedReleaseAsset('index.html', checksum, fetcher), bytes);
  assert.deepEqual(seen, [['https://match.meta-uber-engineer.dev/index.html', 'manual'], ['https://match.meta-uber-engineer.dev/', 'manual']]);
});

test('frontend asset verification rejects cross-origin, non-canonical, repeated, and changed-byte redirects', async () => {
  for (const location of ['https://evil.example/', '/agent/']) {
    let calls = 0;
    await assert.rejects(readVerifiedReleaseAsset('index.html', 'a'.repeat(64), async () => {
      calls++;
      return { status: 302, headers: new Headers({ location }) };
    }), /Non-canonical/);
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(readVerifiedReleaseAsset('index.html', 'a'.repeat(64), async () => {
    calls++;
    return { status: 302, headers: new Headers({ location: '/' }) };
  }), /Repeated/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(readVerifiedReleaseAsset('index.html', 'a'.repeat(64), async url => {
    calls++;
    return String(url).endsWith('/index.html')
      ? { status: 302, headers: new Headers({ location: '/' }) }
      : { status: 200, ok: true, arrayBuffer: async () => Buffer.from('different bytes') };
  }), /bytes differ/);
  assert.equal(calls, 2);
});

test('Given separately sealed artifacts, when preparing deploy, then require exact component and successful run attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'tincanban-component-release-'));
  try {
    const artifacts = join(root, 'artifacts'); const output = join(root, 'deploy');
    mkdirSync(artifacts);
    const files = { 'wrangler.json': Buffer.from(JSON.stringify({ main: 'entry.js', vars: { RELEASE_SDK_SHA: 'd'.repeat(40) }, assets: { directory: './assets' } })), 'entry.js': Buffer.from('checked') };
    writeFileSync(join(artifacts, 'wrangler.json'), files['wrangler.json']);
    writeFileSync(join(artifacts, 'entry.js'), files['entry.js']);
    writeFileSync(join(artifacts, 'artifact.json'), JSON.stringify(sealArtifact({ component: 'frontend', sourceSha: 'a'.repeat(40),
      sdkSha: 'c'.repeat(40), candidateId: '123-4', readers: { privateReplicas: 5 }, writerVersion: 2 }, files)));
    assert.equal(prepareComponent('frontend', artifacts, output, 'a'.repeat(40), '123', '4').component, 'frontend');
    const config = JSON.parse(readFileSync(join(output, 'wrangler.json'), 'utf8'));
    assert.equal(resolve(output, config.main), join(artifacts, 'entry.js'));
    assert.equal(resolve(output, config.assets.directory), join(artifacts, 'assets'));
    assert.equal(config.vars.RELEASE_SDK_SHA, 'c'.repeat(40));
    assert.throws(() => prepareComponent('automation', artifacts, join(root, 'wrong'), 'a'.repeat(40), '123', '4'), /exact successful Verify run/);
    assert.throws(() => prepareComponent('frontend', artifacts, join(root, 'wrong-attempt'), 'a'.repeat(40), '123', '5'), /exact successful Verify run/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('frontend capture keeps retained WASM as static assets and out of Wrangler module discovery', () => {
  const root = mkdtempSync(join(tmpdir(), 'tincanban-frontend-modules-'));
  try {
    const wrangler = resolve('workers/frontend/node_modules/.bin/wrangler');
    assert.ok(existsSync(wrangler), 'Wrangler must be installed to verify frontend Worker module discovery');
    const project = join(root, 'project'); const sdk = join(project, 'vendor', 'meta-mesh');
    const dist = join(project, 'dist'); const artifact = join(project, '.release', 'frontend');
    mkdirSync(join(project, 'release'), { recursive: true });
    mkdirSync(join(project, 'workers', 'frontend'), { recursive: true });
    mkdirSync(join(dist, 'assets'), { recursive: true });
    mkdirSync(sdk, { recursive: true });
    for (const repository of [project, sdk]) {
      execFileSync('git', ['init', '-q'], { cwd: repository });
      execFileSync('git', ['config', 'user.name', 'Release fixture'], { cwd: repository });
      execFileSync('git', ['config', 'user.email', 'release-fixture@example.invalid'], { cwd: repository });
      execFileSync('git', ['commit', '--allow-empty', '-qm', 'fixture'], { cwd: repository });
    }
    writeFileSync(join(project, 'release', 'readers.json'), JSON.stringify({ frontend: { privateReplicas: 5 }, writerVersions: { frontend: 2 } }));
    writeFileSync(join(project, 'workers', 'frontend', 'frontend.mjs'), "export default { fetch() { return new Response('ok'); } };");
    writeFileSync(join(project, 'workers', 'frontend', 'wrangler.jsonc'), readFileSync(new URL('../workers/frontend/wrangler.jsonc', import.meta.url)));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>current</title>');

    const wasmBytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    const oldWasmPaths = ['assets/meta_mesh_bg-old-retained.wasm', 'assets/meta_mesh_policy_bg-old-retained.wasm'];
    const currentWasmPath = 'assets/meta_mesh_bg-current.wasm';
    for (const path of [...oldWasmPaths, currentWasmPath]) writeFileSync(join(dist, path), wasmBytes);
    const wasmDigest = createHash('sha256').update(wasmBytes).digest('hex');
    writeFileSync(join(dist, 'release.json'), JSON.stringify({ retained: Object.fromEntries(oldWasmPaths.map(path => [path, wasmDigest])) }));

    const captureScript = resolve('scripts/capture-release-artifact.mjs');
    const capture = spawnSync(process.execPath, [captureScript, 'frontend', artifact], {
      cwd: project, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, RELEASE_CANDIDATE_ID: '123-4' },
    });
    assert.equal(capture.status, 0, capture.stderr || capture.stdout);
    const capturedConfig = JSON.parse(readFileSync(join(artifact, 'wrangler.json'), 'utf8'));
    assert.equal(capturedConfig.find_additional_modules, false);
    for (const path of [...oldWasmPaths, currentWasmPath]) assert.deepEqual(readFileSync(join(artifact, 'assets', path)), wasmBytes);
    const capturedManifest = JSON.parse(readFileSync(join(artifact, 'assets', 'release.json'), 'utf8'));
    for (const path of oldWasmPaths) assert.equal(capturedManifest.retained[path], wasmDigest);

    const runDryRun = (artifactDirectory, deployDirectory, workerOutput) => {
      prepareComponent('frontend', artifactDirectory, deployDirectory,
        JSON.parse(readFileSync(join(artifactDirectory, 'artifact.json'), 'utf8')).sourceSha, '123', '4');
      return spawnSync(wrangler, ['versions', 'upload', '--config', join(deployDirectory, 'wrangler.json'), '--no-bundle', '--dry-run',
        '--outdir', workerOutput], { cwd: project, encoding: 'utf8', timeout: 60_000 });
    };
    const baselineArtifact = join(project, '.release', 'frontend-with-default-discovery');
    cpSync(artifact, baselineArtifact, { recursive: true });
    const baselineConfigPath = join(baselineArtifact, 'wrangler.json');
    const baselineConfig = JSON.parse(readFileSync(baselineConfigPath, 'utf8'));
    delete baselineConfig.find_additional_modules;
    writeFileSync(baselineConfigPath, JSON.stringify(baselineConfig));
    const baselineIdentity = JSON.parse(readFileSync(join(baselineArtifact, 'artifact.json'), 'utf8'));
    const { artifactSha256, files: ignoredFiles, kind, version, ...identity } = baselineIdentity;
    writeFileSync(join(baselineArtifact, 'artifact.json'), JSON.stringify(sealArtifact(identity, readArtifactFiles(baselineArtifact))));
    const baselineDeploy = join(project, '.release', 'deploy-default-discovery');
    const baselineWorker = join(project, 'worker-default-discovery');
    const baseline = runDryRun(baselineArtifact, baselineDeploy, baselineWorker);
    assert.equal(baseline.status, 0, baseline.stderr || baseline.stdout);
    const baselineWorkerFiles = listFiles(baselineWorker);
    assert.ok(baselineWorkerFiles.some(path => path.endsWith('.wasm')), 'Default additional-module discovery reproduces WASM in Worker output');

    const fixedDeploy = join(project, '.release', 'deploy-frontend');
    const fixedWorker = join(project, 'worker-frontend');
    const fixed = runDryRun(artifact, fixedDeploy, fixedWorker);
    assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout);
    assert.ok(!listFiles(fixedWorker).some(path => path.endsWith('.wasm')), 'Captured WASM assets must stay out of Worker module output');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('automation Wrangler module paths resolve back into the sealed bundle directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'tincanban-automation-release-'));
  try {
    const artifacts = join(root, 'artifact'); const output = join(root, 'deploy');
    mkdirSync(join(artifacts, 'bundle'), { recursive: true });
    const config = { main: 'bundle/index.js', base_dir: 'bundle', vars: { RELEASE_SDK_SHA: 'd'.repeat(40) } };
    const files = { 'wrangler.json': Buffer.from(JSON.stringify(config)), 'bundle/index.js': Buffer.from('checked worker') };
    writeFileSync(join(artifacts, 'wrangler.json'), files['wrangler.json']);
    writeFileSync(join(artifacts, 'bundle/index.js'), files['bundle/index.js']);
    writeFileSync(join(artifacts, 'artifact.json'), JSON.stringify(sealArtifact({ component: 'automation', sourceSha: 'a'.repeat(40),
      sdkSha: 'c'.repeat(40), candidateId: '234-1', readers: { automationState: 5 }, writerVersion: 2 }, files)));
    prepareComponent('automation', artifacts, output, 'a'.repeat(40), '234', '1');
    const prepared = JSON.parse(readFileSync(join(output, 'wrangler.json'), 'utf8'));
    assert.equal(resolve(output, prepared.main), join(artifacts, 'bundle/index.js'));
    assert.equal(resolve(output, prepared.base_dir), join(artifacts, 'bundle'));
    assert.equal(prepared.vars.RELEASE_SDK_SHA, 'c'.repeat(40));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reader and writer floors apply to selected service only', async () => {
  const fetcher = async () => ({ ok: true, status: 200, json: async () => ({
    contract: { minimumWriterVersion: 2, readers: { frontend: { privateReplicas: 5 } } },
  }) });
  await assert.rejects(assertActiveCompatibility('frontend', { ...artifact, readers: { privateReplicas: 4 }, writerVersion: 2 }, fetcher), /rollback reader/);
  await assert.rejects(assertActiveCompatibility('frontend', { ...artifact, readers: { privateReplicas: 5 }, writerVersion: 1 }, fetcher), /writer rollback/);
  await assert.doesNotReject(assertActiveCompatibility('frontend', artifact, fetcher));
  await assert.doesNotReject(assertActiveCompatibility('frontend', artifact, async () => ({ status: 404, ok: false })));
  await assert.rejects(assertActiveCompatibility('frontend', artifact, async () => ({ status: 503, ok: false })), /Cannot establish current/);
});

test('frontend rollback retains exact still-live chunks from the active sealed artifact', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tincanban-rollback-'));
  const targetDir = join(root, 'target'); const currentDir = join(root, 'current'); const output = join(root, 'output');
  const { createHash } = await import('node:crypto');
  const digest = value => createHash('sha256').update(value).digest('hex');
  const targetHtml = Buffer.from('old html'); const targetChunk = Buffer.from('old chunk'); const currentChunk = Buffer.from('new chunk');
  const oldPath = 'assets/old-12345678.js'; const newPath = 'assets/new-12345678.js';
  const createBundle = (directory, sha, files) => {
    mkdirSync(join(directory, 'assets/assets'), { recursive: true });
    writeFileSync(join(directory, 'assets/index.html'), files.html);
    writeFileSync(join(directory, `assets/${oldPath}`), files.old);
    if (files.new) writeFileSync(join(directory, `assets/${newPath}`), files.new);
    const manifest = { sha, files: { 'index.html': digest(files.html), [oldPath]: digest(files.old) }, retained: {}, retainedUntil: {} };
    if (files.new) {
      manifest.files[newPath] = digest(files.new);
      manifest.retained[newPath] = digest(files.new);
      manifest.retainedUntil[newPath] = Date.now() + 86_400_000;
    }
    writeFileSync(join(directory, 'assets/release.json'), JSON.stringify(manifest));
    const bundleFiles = Object.fromEntries([
      ['assets/index.html', files.html], ['assets/release.json', Buffer.from(JSON.stringify(manifest))],
      [`assets/${oldPath}`, files.old], ...(files.new ? [[`assets/${newPath}`, files.new]] : []),
    ]);
    writeFileSync(join(directory, 'artifact.json'), JSON.stringify(sealArtifact({ component: 'frontend', sourceSha: sha,
      sdkSha: 'c'.repeat(40), candidateId: '123-1', readers: { privateReplicas: 5 }, writerVersion: 2 }, bundleFiles)));
  };
  try {
    createBundle(targetDir, 'a'.repeat(40), { html: targetHtml, old: targetChunk });
    createBundle(currentDir, 'd'.repeat(40), { html: Buffer.from('new html'), old: targetChunk, new: currentChunk });
    const result = composeFrontendRollback(targetDir, currentDir, output);
    assert.equal(result.derivedFrom.length, 2);
    assert.deepEqual(readFileSync(join(output, `assets/${newPath}`)), currentChunk);
    const manifest = JSON.parse(readFileSync(join(output, 'assets/release.json'), 'utf8'));
    assert.equal(manifest.retained[newPath], digest(currentChunk));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('app production workflows select one exact artifact component without Rusty or paired-release gates', () => {
  const frontend = readFileSync(new URL('../.github/workflows/deploy-frontend.yml', import.meta.url), 'utf8');
  const automation = readFileSync(new URL('../.github/workflows/deploy-automation.yml', import.meta.url), 'utf8');
  for (const [component, workflow] of [['frontend', frontend], ['automation', automation]]) {
    assert.match(workflow, new RegExp(`tincanban-${component}-cohort-`));
    assert.match(workflow, new RegExp(`prepare ${component}`));
    assert.doesNotMatch(workflow, /release-product|releaseId|RELEASE_ID|RUSTY_DEPLOY|RUSTY_TRUSTED_OWNER|deploy-rusty-cohort/);
    const artifactNames = workflow.match(/tincanban-(?:frontend|automation)-cohort-/g) ?? [];
    assert.equal(artifactNames.length, 1);
  }
  assert.doesNotMatch(frontend, /AUTOMATION_TELEMETRY_TOKEN/);
  const recovery = readFileSync(new URL('../.github/workflows/recover-release.yml', import.meta.url), 'utf8');
  assert.match(recovery, /options: \[frontend, automation\]/);
  assert.match(recovery, /source_run/);
  assert.match(recovery, /source_attempt/);
  assert.doesNotMatch(recovery, /RUSTY_DEPLOY|RELEASE_ID|release-product/);
});
