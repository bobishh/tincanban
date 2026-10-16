import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { automationSecrets, writeAutomationSecrets } from './automation-secrets.mjs';

test('Given all executor credentials, When staging an intake release, Then exact Worker names receive structured secret values', () => {
  assert.deepEqual(automationSecrets({
    AUTOMATION_TELEMETRY_TOKEN: 'telemetry', AUTOMATION_EXECUTOR_SERVICE_TOKEN: 'service',
    AUTOMATION_EXECUTOR_MIGRATION_SECRET: 'migration', AUTOMATION_CLASSIFICATION_SERVICE_TOKEN: 'classification',
  }), { TELEMETRY_TOKEN: 'telemetry', EXECUTOR_SERVICE_TOKEN: 'service', EXECUTOR_MIGRATION_SECRET: 'migration', CLASSIFICATION_SERVICE_TOKEN: 'classification' });
});

test('Given an older rollback without executor secrets, When staging its release, Then existing unrelated secrets remain untouched', () => {
  assert.deepEqual(automationSecrets({}), {});
  assert.deepEqual(automationSecrets({ AUTOMATION_TELEMETRY_TOKEN: 'telemetry' }), { TELEMETRY_TOKEN: 'telemetry' });
  assert.throws(() => automationSecrets({ AUTOMATION_EXECUTOR_SERVICE_TOKEN: 'partial' }), /configured together/);
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
