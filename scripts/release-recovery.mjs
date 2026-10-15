import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sealArtifact, verifyArtifact, readArtifactFiles, assertCompatibleRollback } from './release-cohort.mjs';
import { checkRelease, retainedAsset, retentionCandidates } from '../workers/frontend/release.mjs';

const load = path => JSON.parse(readFileSync(path, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const components = ['frontend', 'automation', 'rusty'];
export function selectCompatibleRollback(current, target) {
  for (const [component, floors] of Object.entries(current.contract.readers)) {
    const artifact = target.components[component];
    if (!artifact) throw new Error(`Missing rollback ${component}`);
    assertCompatibleRollback(artifact, floors);
    if (artifact.writerVersion < current.contract.minimumWriterVersion) throw new Error(`Incompatible rollback writer: ${component}`);
  }
  for (const [component, capabilities] of Object.entries(current.contract.capabilities ?? {})) {
    for (const [name, required] of Object.entries(capabilities)) {
      const available = target.contract?.capabilities?.[component]?.[name];
      const minimum = typeof required === 'number' ? required : required.version;
      const version = typeof available === 'number' ? available : available?.version ?? 0;
      if (version < minimum || (required.actions ?? []).some(action => !available?.actions?.includes(action))) throw new Error(`Incompatible rollback capability: ${component}/${name}`);
    }
  }
  return target;
}
export function composeRollbackFrontend(target, current, now = Date.now()) {
  verifyArtifact(target.artifact, target.files); verifyArtifact(current.artifact, current.files);
  if (target.artifact.component !== 'frontend' || current.artifact.component !== 'frontend') throw new Error('Retention requires sealed frontend artifacts');
  const files = { ...target.files };
  const previous = JSON.parse(current.files['assets/release.json']);
  const manifest = JSON.parse(target.files['assets/release.json']);
  checkRelease(previous, current.artifact.sourceSha, path => current.files[`assets/${path}`]);
  checkRelease(manifest, target.artifact.sourceSha, path => target.files[`assets/${path}`]);
  const retained = {}, retainedUntil = {};
  // Source manifests determine expiry; copying an already retained chunk never refreshes it.
  for (const [source, sourceFiles] of [[manifest, target.files], [previous, current.files]]) {
    for (const [path, hash, until] of retentionCandidates(source, now)) {
      const key = `assets/${path}`;
      const bytes = sourceFiles[key];
      if (!bytes || digest(bytes) !== hash) throw new Error(`Rollback chunk missing or changed: ${path}`);
      if (files[key] && digest(files[key]) !== hash) throw new Error(`Rollback chunk path collision: ${path}`);
      if (manifest.files[path]) continue;
      files[key] = bytes;
      retained[path] = hash;
      retainedUntil[path] = Math.min(retainedUntil[path] ?? until, until);
    }
  }
  for (const path of Object.keys(files)) {
    const assetPath = path.startsWith('assets/') ? path.slice(7) : '';
    if (retainedAsset(assetPath) && !manifest.files[assetPath] && !retained[assetPath]) delete files[path];
  }
  files['assets/release.json'] = Buffer.from(JSON.stringify({ ...manifest, retained, retainedUntil, previousSha: current.artifact.sourceSha }));
  const { files: ignoredFiles, artifactSha256: ignoredHash, kind: ignoredKind, version: ignoredVersion, ...identity } = target.artifact;
  const artifact = sealArtifact({ ...identity, derivedFrom: [target.artifact.artifactSha256, current.artifact.artifactSha256] }, files);
  return { artifact, files };
}
export function assertRecoveryRun(run, repository, runId, attempt) {
  if (!/^[1-9][0-9]*$/.test(String(runId)) || !/^[1-9][0-9]*$/.test(String(attempt)) ||
    String(run.id) !== String(runId) || String(run.run_attempt) !== String(attempt) || run.head_branch !== 'main' ||
    !['workflow_run', 'workflow_dispatch'].includes(run.event) ||
    !['.github/workflows/deploy-frontend.yml', '.github/workflows/recover-release.yml'].includes(run.path) ||
    run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) throw new Error('Archive must belong to the exact trusted production workflow attempt');
}
function ghJson(args) { return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })); }
function downloadRecoveryArchive(repository, runId, attempt, directory) {
  if (!/^[1-9][0-9]*$/.test(String(runId)) || !/^[1-9][0-9]*$/.test(String(attempt))) throw new Error('Select numeric trusted production run and attempt');
  if (existsSync(directory)) throw new Error('Recovery archive destination already exists');
  const run = ghJson(['api', `repos/${repository}/actions/runs/${runId}/attempts/${attempt}`]);
  assertRecoveryRun(run, repository, runId, attempt);
  const pages = ghJson(['api', '--paginate', '--slurp', `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`]);
  const artifacts = pages.flatMap(page => page.artifacts);
  const chosen = ['result', 'staged'].map(state => artifacts.find(artifact => artifact.name === `cohort-${state}-${runId}-${attempt}` && !artifact.expired)).find(Boolean);
  if (!chosen) throw new Error('No retained exact activation archive; never reconstruct provider versions from tags');
  execFileSync('gh', ['run', 'download', String(runId), '--repo', repository, '--name', chosen.name, '--dir', directory], { stdio: 'inherit' });
  const journal = load(join(directory, 'activation.json'));
  if (String(journal.deploymentRunId) !== String(runId) || String(journal.deploymentRunAttempt) !== String(attempt)) throw new Error('Activation archive provenance differs from selected workflow attempt');
  for (const component of components) verifyArtifact(load(join(directory, component, 'artifact.json')), readArtifactFiles(join(directory, component)));
  return { repository, runId: String(runId), attempt: String(attempt), artifactId: chosen.id, artifactName: chosen.name };
}
function writeArtifact(directory, value) {
  mkdirSync(directory, { recursive: true });
  for (const [path, bytes] of Object.entries(value.files)) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), bytes);
  }
  writeFileSync(join(directory, 'artifact.json'), JSON.stringify(value.artifact));
}
export function materializeRollback(currentDirectory, targetDirectory, destination, now = Date.now()) {
  if (existsSync(destination)) throw new Error('Refuse to replace rollback evidence');
  const current = load(join(currentDirectory, 'cohort.json'));
  const target = selectCompatibleRollback(current, load(join(targetDirectory, 'cohort.json')));
  const selected = {};
  for (const component of components) {
    const artifact = target.components[component], files = readArtifactFiles(join(targetDirectory, component));
    verifyArtifact(artifact, files);
    selected[component] = { artifact, files };
  }
  selected.frontend = composeRollbackFrontend(selected.frontend, {
    artifact: current.components.frontend, files: readArtifactFiles(join(currentDirectory, 'frontend')) }, now);
  for (const component of components) writeArtifact(join(destination, component), selected[component]);
  return { current, target, selected: Object.fromEntries(components.map(component => [component, selected[component].artifact])) };
}
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
