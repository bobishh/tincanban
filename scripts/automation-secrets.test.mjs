import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationSecrets, writeAutomationSecrets } from './automation-secrets.mjs';
import { deploymentBrowserClient } from './deployment-browser-client.mjs';

test('Given an ordinary build, When preparing its HTML, Then no browser producer is included', () => {
  assert.deepEqual(deploymentBrowserClient({}), []);
});

test('Given a deployed external dependency, When preparing HTML, Then load the configured script with its public credential', () => {
  assert.deepEqual(deploymentBrowserClient({ ANALYTICS_CLIENT_URL: 'https://client.example.test/extension.js', ANALYTICS_PROJECT: 'fixture', ANALYTICS_BROWSER_TOKEN: 'public-key' }), [{
    tag: 'script', attrs: { defer: true, src: 'https://client.example.test/extension.js', 'data-project': 'fixture', 'data-token': 'public-key' }, injectTo: 'head',
  }]);
});

test('Given source deployment defaults, When no collector is supplied, Then no external telemetry endpoint is configured', () => {
  const config = JSON.parse(readFileSync(new URL('../workers/automation/wrangler.jsonc', import.meta.url), 'utf8'));
  assert.equal(Object.hasOwn(config.vars, 'OTEL_EXPORTER_OTLP_ENDPOINT'), false);
});

test('Given a deployment-owned external collector, When staging a release, Then inject its endpoint with the runtime bindings', () => {
  assert.deepEqual(automationSecrets({ AUTOMATION_OTEL_ENDPOINT: 'https://collector.example.test' }), {
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example.test',
  });
});

test('Given Reflux ingress credentials, When staging an automation release, Then use only current Worker secret bindings', () => {
  assert.deepEqual(automationSecrets({
    AUTOMATION_TELEMETRY_TOKEN: 'telemetry', AUTOMATION_REFLUX_SERVICE_TOKEN: 'reflux',
  }), { TELEMETRY_TOKEN: 'telemetry', REFLUX_SERVICE_TOKEN: 'reflux' });
});

test('Given absent optional credentials, When staging a release, Then preserve unrelated secret bindings', () => {
  assert.deepEqual(automationSecrets({}), {});
  assert.deepEqual(automationSecrets({ AUTOMATION_TELEMETRY_TOKEN: 'telemetry' }), { TELEMETRY_TOKEN: 'telemetry' });
});

test('Given shell-sensitive credential text, When staging secrets, Then a private JSON file preserves bytes without evaluation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'automation-secrets-'));
  try {
    const path = join(directory, 'secrets.json');
    const source = { AUTOMATION_TELEMETRY_TOKEN: 'literal $(command) "value"\nnext line' };
    assert.equal(writeAutomationSecrets(path, source), true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { TELEMETRY_TOKEN: source.AUTOMATION_TELEMETRY_TOKEN });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => writeAutomationSecrets(path, source), /EEXIST/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
