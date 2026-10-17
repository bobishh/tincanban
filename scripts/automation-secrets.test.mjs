import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationSecrets, writeAutomationSecrets } from './automation-secrets.mjs';

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
