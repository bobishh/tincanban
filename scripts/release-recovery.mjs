import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { downloadRecoveryArchive } from './release-recovery-core.mjs';
export { composeRollbackFrontend, selectCompatibleRollback, assertRecoveryRun, materializeRollback } from './release-recovery-core.mjs';

const load = path => JSON.parse(readFileSync(path, 'utf8'));

async function main() {
  const [command, runId, attempt, targetRunId, targetAttempt] = process.argv.slice(2);
  if (!['resume', 'rollback'].includes(command)) throw new Error('Use resume|rollback <activation-run> <attempt> [<rollback-target-run> <attempt>]');
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository !== 'bobishh/tincanban') throw new Error('Recovery belongs to the configured production repository');
  const coordinator = await import('./release-coordinator.mjs');
  coordinator.assertImplementationGate(load('release/implementation-gate.json'));
  const source = resolve('.recovery/current');
  const provenance = downloadRecoveryArchive(repository, runId, attempt, source);
  const destination = resolve('.release');
  if (command === 'resume') {
    const { cpSync } = await import('node:fs');
    if (existsSync(destination)) throw new Error('Release destination already exists');
    cpSync(source, destination, { recursive: true });
    await coordinator.prepareResume(destination, provenance);
  } else {
    const target = resolve('.recovery/target');
    const targetProvenance = downloadRecoveryArchive(repository, targetRunId, targetAttempt, target);
    await coordinator.prepareRollback(source, target, destination, { current: provenance, target: targetProvenance });
  }
  console.log(`Prepared ${command} using exact archived artifacts`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
