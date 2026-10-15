import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertImplementationGate, publicCohort } from './release-coordinator.mjs';
import { parseRustyDeploySpec } from './deploy-rusty-cohort.mjs';

test('Given unfinished architecture implementation, when release prepares, then fail before staging or activation', () => {
  assert.throws(() => assertImplementationGate({ version: 1, implementationComplete: false }), /implementation blocks/);
});

test('Given release status for browsers, when projecting a cohort, then expose exact identities without transferring build file tables or inventing device acknowledgement', () => {
  const input = { kind: 'tincanban-release-cohort', version: 1, cohortId: 'a'.repeat(64),
    components: { frontend: { component: 'frontend', sourceSha: 'b'.repeat(40), sdkSha: 'c'.repeat(40),
      candidateId: '42-1', artifactSha256: 'd'.repeat(64), readers: { privateReplicas: 4 }, writerVersion: 2, files: { 'private-build-metadata': 'e'.repeat(64) } } },
    contract: { minimumWriterVersion: 2, readers: { frontend: { privateReplicas: 4 } }, rollbackReaders: [{ files: { private: 'omitted' } }] } };
  const projected = publicCohort(input);
  assert.equal(projected.components.frontend.artifactSha256, input.components.frontend.artifactSha256);
  assert.equal(projected.components.frontend.files, undefined);
  assert.equal(projected.deviceAcknowledged, undefined);
  assert.equal(projected.contract.rollbackReaders, undefined);
});
test('Given native activation, when the production Kamal checkout, config, host or origin are ambiguous, then refuse rather than selecting another deployment', () => {
  const exact = { kind: 'kamal', directory: '.release-config/production', configSha: 'a'.repeat(40), configFile: 'config/deploy.mesh-lighthouse.yml',
    server: 'rusty.example', origin: 'https://rusty.example' };
  assert.deepEqual(parseRustyDeploySpec(JSON.stringify(exact)), exact);
  for (const changed of [{ kind: 'ssh-compose' }, { configSha: 'unverified' }, { directory: '/srv/../other' }, { configFile: 'config/deploy.yml' },
    { server: 'host; command' }, { origin: 'http://rusty.example' }]) {
    assert.throws(() => parseRustyDeploySpec(JSON.stringify({ ...exact, ...changed })), /exact existing/);
  }
});
test('Given a production cohort rollout, when orchestrated, then native and Worker confirmations precede frontend activation and no source rebuild occurs in deploy', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-frontend.yml', import.meta.url), 'utf8');
  assert.ok(workflow.indexOf('activate .release rusty') < workflow.indexOf('activate .release automation'));
  assert.ok(workflow.indexOf('activate .release automation') < workflow.indexOf('activate .release frontend'));
  assert.match(workflow, /--no-bundle/);
  assert.doesNotMatch(workflow, /npm run build|pnpm .* install|--version-tag/);
});

test('Given a retry of Verify, when capturing a cohort, then frontend and automation come from the same exact run attempt', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /name: tincanban-frontend-cohort-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(workflow, /name: tincanban-automation-cohort-\$\{\{ github\.sha \}\}-\$\{\{ github\.run_attempt \}\}/);
});

test('Given an interrupted rollout with uncertain server stages, when resuming, then confirm first and retry only the missing component before frontend', async () => {
  const { resumeStages } = await import('./release-coordinator.mjs');
  const steps = [];
  await resumeStages({
    confirm: async component => { steps.push(`confirm:${component}`); if (component === 'automation') throw new Error('Previous version still active'); },
    activate: async component => { steps.push(`activate:${component}`); },
    complete: async () => { steps.push('complete'); },
  });
  assert.deepEqual(steps, ['confirm:rusty', 'confirm:automation', 'activate:automation', 'confirm:frontend', 'complete']);
});
test('Given a failing native recovery, when resuming, then automation and frontend are never activated', async () => {
  const { resumeStages } = await import('./release-coordinator.mjs');
  const steps = [];
  await assert.rejects(resumeStages({ confirm: async () => { throw new Error('Not ready'); },
    activate: async component => { steps.push(component); throw new Error('Native unavailable'); }, complete: async () => {} }), /Native unavailable/);
  assert.deepEqual(steps, ['rusty']);
});
test('Given the pre-coordinator deployment has no release manifest, when preparing the first cohort, then use the same checked bootstrap retention manifest', async () => {
  const { productionReleaseManifest } = await import('./release-coordinator.mjs');
  const expected = JSON.parse(readFileSync(new URL('../workers/frontend/bootstrap-assets.json', import.meta.url), 'utf8'));
  assert.deepEqual(await productionReleaseManifest(async () => ({ status: 404 })), expected);
  await assert.rejects(productionReleaseManifest(async () => ({ status: 503 })), /production retention/);
});

test('Given an older checkpoint service without observed-sequence fencing, when confirming a cohort, then refuse it before activating the frontend', async () => {
  const { assertRustyCohortCapabilities } = await import('./release-coordinator.mjs');
  const contract = { snapshotCheckpoints: { version: 1, observedSequence: true }, scopeManagement: 1 };
  assert.throws(() => assertRustyCohortCapabilities({ snapshotCheckpoints: { version: 1 }, scopeManagement: { version: 1 } }, contract), /snapshotCheckpoints/);
  assert.throws(() => assertRustyCohortCapabilities({ snapshotCheckpoints: { version: 1, observedSequence: 'true' }, scopeManagement: { version: 1 } }, contract), /snapshotCheckpoints/);
  assert.throws(() => assertRustyCohortCapabilities({ snapshotCheckpoints: { version: 1, observedSequence: true }, scopeManagement: { version: 0 } }, contract), /scopeManagement/);
  assert.doesNotThrow(() => assertRustyCohortCapabilities({ snapshotCheckpoints: { version: 1, observedSequence: true }, scopeManagement: { version: 1 } }, contract));
});
