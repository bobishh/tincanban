import assert from 'node:assert/strict';
import test from 'node:test';
import { activateExecutor, parseRuntimeEnvironment, validateArtifact, validateDeploymentPin } from './deploy.mjs';

test('Given a running executor, When its replacement succeeds, Then the prior writer stops before activation', async () => {
  const actions = [];
  await activateExecutor({
    stopPrevious: async () => actions.push('stop previous executor'),
    activate: async () => actions.push('activate checked executor'),
    verify: async () => actions.push('verify checked executor'),
    restore: async () => actions.push('restore previous executor'),
  });
  assert.deepEqual(actions, ['stop previous executor', 'activate checked executor', 'verify checked executor']);
});

test('Given a saved prior writer, When activation health fails, Then only the executor handoff rolls back', async () => {
  const actions = [];
  await assert.rejects(activateExecutor({
    stopPrevious: async () => actions.push('stop previous executor'),
    activate: async () => actions.push('activate checked executor'),
    verify: async () => { throw new Error('Artifact mismatch'); },
    restore: async () => actions.push('restore previous executor'),
  }), /Artifact mismatch/);
  assert.deepEqual(actions, ['stop previous executor', 'activate checked executor', 'restore previous executor']);
});

test('Given runtime JSON, When deploy reads it, Then only declared keys become environment values without shell interpretation', () => {
  const source = { EXECUTOR_SERVICE_TOKEN: '$(never-execute)', INTEGRATIONS_JSON: '[{"id":"one"}]' };
  assert.deepEqual(parseRuntimeEnvironment(JSON.stringify(source)), source);
  assert.throws(() => parseRuntimeEnvironment('{"PATH":"/tmp"}'), /Unsupported executor runtime key/);
  assert.throws(() => parseRuntimeEnvironment('{"EXECUTOR_SERVICE_TOKEN":1}'), /string/);
  assert.throws(() => parseRuntimeEnvironment('{"EXECUTOR_SERVICE_TOKEN":"line\\nbreak"}'), /single-line/);
});

test('Given a deployment pin, When it targets another service or mutable revision, Then deployment stops before host access', () => {
  const pin = { repository: 'https://tangled.org/bobishh.bsky.social/hetzner_kamal', commit: 'a'.repeat(40), path: 'config/deploy.tincanban-executor.yml', origin: 'https://executor.meta-uber-engineer.dev' };
  assert.deepEqual(validateDeploymentPin(pin), pin);
  assert.throws(() => validateDeploymentPin({ ...pin, path: 'config/deploy.mesh-lighthouse.yml' }), /pinned executor/);
  assert.throws(() => validateDeploymentPin({ ...pin, commit: 'main' }), /pinned executor/);
});

test('Given image evidence, When source or component differs, Then it cannot be deployed as the checked executor', () => {
  const sourceSha = 'a'.repeat(40), sdkSha = 'b'.repeat(40);
  const artifact = { component: 'tincanban-executor', sourceSha, sdkSha, artifactSha256: 'c'.repeat(64), imageId: `sha256:${'d'.repeat(64)}`, archiveSha256: 'e'.repeat(64) };
  assert.deepEqual(validateArtifact(artifact, sourceSha, sdkSha), artifact);
  assert.throws(() => validateArtifact({ ...artifact, sourceSha: 'f'.repeat(40) }, sourceSha, sdkSha), /checked executor/);
  assert.throws(() => validateArtifact({ ...artifact, component: 'rusty' }, sourceSha, sdkSha), /checked executor/);
});
