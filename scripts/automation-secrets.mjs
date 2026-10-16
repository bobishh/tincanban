import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const executorSecrets = {
  AUTOMATION_EXECUTOR_SERVICE_TOKEN: 'EXECUTOR_SERVICE_TOKEN',
  AUTOMATION_EXECUTOR_MIGRATION_SECRET: 'EXECUTOR_MIGRATION_SECRET',
  AUTOMATION_CLASSIFICATION_SERVICE_TOKEN: 'CLASSIFICATION_SERVICE_TOKEN',
};

export function automationSecrets(environment) {
  const configured = Object.keys(executorSecrets).filter(key => environment[key]);
  if (configured.length && configured.length !== Object.keys(executorSecrets).length) {
    throw new Error('Automation executor credentials must be configured together');
  }
  return Object.fromEntries(Object.entries({ AUTOMATION_TELEMETRY_TOKEN: 'TELEMETRY_TOKEN', ...executorSecrets })
    .filter(([source]) => environment[source])
    .map(([source, target]) => [target, environment[source]]));
}

/** A missing credential set preserves the current bindings during an older rollback. */
export function writeAutomationSecrets(path, environment = process.env) {
  const secrets = automationSecrets(environment);
  if (!Object.keys(secrets).length) return false;
  writeFileSync(path, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!process.argv[2]) throw new Error('Usage: automation-secrets.mjs <private-output-file>');
  writeAutomationSecrets(process.argv[2]);
}
