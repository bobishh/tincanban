import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { canonical, assembleCohort, verifyArtifact, readArtifactFiles, verifyComponentObservation, assertCompatibleRollback, assertCohortCapabilities } from './release-cohort.mjs';
import { parseRustyDeploySpec, deployRustyArtifact } from './deploy-rusty-cohort.mjs';
import { createHash } from 'node:crypto';
import { materializeRollback } from './release-recovery.mjs';
import { uploadedVersion } from '../workers/frontend/release.mjs';

const load = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value));
const hashManifest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fullSha = value => /^[a-f0-9]{40}$/.test(value ?? '');
function checkedCohort(directory) {
  const cohort = load(join(directory, 'cohort.json'));
  if (assembleCohort(cohort.components, cohort.contract).cohortId !== cohort.cohortId) throw new Error('Release cohort seal changed');
  for (const component of ['frontend', 'automation', 'rusty']) verifyArtifact(cohort.components[component], readArtifactFiles(join(directory, component)));
  const journal = load(join(directory, 'activation.json'));
  if (journal.cohortId !== cohort.cohortId) throw new Error('Activation journal belongs to another cohort');
  return cohort;
}
export function assertImplementationGate(gate) {
  if (gate?.version !== 1 || gate.implementationComplete !== true || gate.acceptanceContract !==
    'openspec/changes/unified-device-and-replica-architecture/specs/device-and-replica-contracts/spec.md') {
    throw new Error('All architecture implementation blocks must close before release activation');
  }
}
function rustyRevision() {
  const matches = [...readFileSync('.github/workflows/ci.yml', 'utf8').matchAll(/^  RUSTY_REVISION: ([a-f0-9]{40})$/gm)];
  if (matches.length !== 1) throw new Error('Expected one exact Rusty revision in the checked CI contract');
  return matches[0][1];
}
export function publicCohort(cohort) {
  return { kind: cohort.kind, version: cohort.version, cohortId: cohort.cohortId,
    components: Object.fromEntries(Object.entries(cohort.components).map(([component, artifact]) => [component, {
      component, sourceSha: artifact.sourceSha, sdkSha: artifact.sdkSha, candidateId: artifact.candidateId,
      artifactSha256: artifact.artifactSha256, image: artifact.image, binarySha256: artifact.binarySha256,
      readers: artifact.readers, writerVersion: artifact.writerVersion,
    }])), contract: { minimumWriterVersion: cohort.contract.minimumWriterVersion, readers: cohort.contract.readers } };
}
async function getJson(url) {
  const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Release observation failed: ${new URL(url).pathname} (${response.status})`);
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('Release observation exceeds limit');
  return JSON.parse(text);
}
export async function productionReleaseManifest(fetcher = fetch) {
  const response = await fetcher('https://match.meta-uber-engineer.dev/release.json', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return load('workers/frontend/bootstrap-assets.json');
  if (!response.ok) throw new Error('Cannot read production retention manifest');
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('Production retention manifest exceeds limit');
  return JSON.parse(text);
}
function deployConfig(artifact, cohort, source, component) {
  const config = structuredClone(source);
  config.main = `../${component}/${source.main}`;
  if (config.assets) config.assets.directory = `../${component}/${source.assets.directory}`;
  if (config.base_dir) config.base_dir = `../${component}/${source.base_dir}`;
  config.vars = { ...config.vars, RELEASE_SHA: artifact.sourceSha, RELEASE_SDK_SHA: artifact.sdkSha,
    RELEASE_ARTIFACT_SHA256: artifact.artifactSha256, RELEASE_COHORT_ID: cohort.cohortId,
    RELEASE_READERS_JSON: JSON.stringify(artifact.readers), RELEASE_WRITER_VERSION: String(artifact.writerVersion) };
  if (component === 'frontend') config.vars.RELEASE_COHORT_JSON = JSON.stringify(publicCohort(cohort));
  return config;
}
async function prepare(directory, expectedSha) {
  assertImplementationGate(load('release/implementation-gate.json'));
  if (!fullSha(expectedSha)) throw new Error('Missing exact verified application revision');
  const host = parseRustyDeploySpec(process.env.RUSTY_DEPLOY_SPEC);
  const components = Object.fromEntries(['frontend', 'automation', 'rusty'].map(component => {
    const artifactDirectory = join(directory, component);
    const artifact = load(join(artifactDirectory, 'artifact.json'));
    verifyArtifact(artifact, readArtifactFiles(artifactDirectory));
    return [component, artifact];
  }));
  const sdk = execFileSync('git', ['rev-parse', 'HEAD:vendor/meta-mesh'], { encoding: 'utf8' }).trim();
  if (components.frontend.sourceSha !== expectedSha || components.automation.sourceSha !== expectedSha ||
    components.frontend.sdkSha !== sdk || components.rusty.sourceSha !== rustyRevision() ||
    components.frontend.candidateId !== `${process.env.VERIFIED_RUN_ID}-${process.env.VERIFIED_RUN_ATTEMPT}` ||
    components.rusty.candidateId !== `${process.env.RUSTY_RUN_ID}-${process.env.RUSTY_RUN_ATTEMPT}`) throw new Error('Downloaded components differ from the exact verified sources');
  const contract = load('release/contract.json');
  // Retain checked forward-recovery readers even when the prior release cannot read a new schema.
  contract.rollbackReaders = Object.values(components).map(({ component, artifactSha256, readers, writerVersion }) => ({ component, artifactSha256, readers, writerVersion }));
  const cohort = assembleCohort(components, contract);
  const previous = await productionReleaseManifest();
  const captured = load(join(directory, 'frontend/assets/release.json'));
  if (hashManifest(previous) !== captured.previousManifestSha256 && hashManifest(previous) !== hashManifest(captured)) throw new Error('Production bytes changed after chunk retention; rebuild the candidate before activation');
  let previousCohort = null;
  const previousResponse = await fetch('https://match.meta-uber-engineer.dev/release-cohort.json', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (previousResponse.ok) {
    previousCohort = await previousResponse.json();
    if (previousCohort.kind !== 'tincanban-release-cohort' || !/^[a-f0-9]{64}$/.test(previousCohort.cohortId ?? '')) throw new Error('Invalid previous production cohort');
  } else if (![404, 503].includes(previousResponse.status)) throw new Error('Cannot establish previous production cohort');
  if (previousCohort) {
    if (cohort.contract.minimumWriterVersion < previousCohort.contract.minimumWriterVersion) throw new Error('Release would lower the retained writer floor');
    for (const component of ['frontend', 'automation', 'rusty']) {
      assertCompatibleRollback(components[component], previousCohort.contract.readers[component]);
      assertCompatibleRollback({ readers: cohort.contract.readers[component] }, previousCohort.contract.readers[component]);
    }
  }
  save(join(directory, 'cohort.json'), cohort);
  mkdirSync(join(directory, 'deploy'), { recursive: true });
  for (const component of ['frontend', 'automation']) save(join(directory, 'deploy', `${component}.json`),
    deployConfig(components[component], cohort, load(join(directory, component, 'wrangler.json')), component));
  const journal = { kind: 'tincanban-release-activation', version: 1, cohortId: cohort.cohortId, state: 'prepared',
    verifiedRunId: process.env.VERIFIED_RUN_ID, verifiedRunAttempt: process.env.VERIFIED_RUN_ATTEMPT,
    deploymentRunId: process.env.GITHUB_RUN_ID, deploymentRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    nativeRunId: process.env.RUSTY_RUN_ID, nativeRunAttempt: process.env.RUSTY_RUN_ATTEMPT,
    previousCohort, previousSha: previous.sha, previousManifestSha256: hashManifest(previous), sourceSha: expectedSha, nativeOrigin: host.origin,
    components: { rusty: { state: 'prepared' }, automation: { state: 'prepared' }, frontend: { state: 'prepared' } } };
  save(join(directory, 'activation.json'), journal);
  return cohort;
}
function recordVersion(directory, component, outputPath) {
  if (!['frontend', 'automation'].includes(component)) throw new Error('Unexpected Worker component');
  const journal = load(join(directory, 'activation.json'));
  const versionId = uploadedVersion(readFileSync(outputPath, 'utf8'));
  if (journal.components[component].versionId && journal.components[component].versionId !== versionId) throw new Error('Refuse to replace an exact staged provider version');
  journal.components[component] = { ...journal.components[component], state: 'staged', versionId };
  journal.state = Object.values(journal.components).filter(value => value.versionId).length === 2 ? 'staged' : 'staging';
  save(join(directory, 'activation.json'), journal);
}
export { assertCohortCapabilities as assertRustyCohortCapabilities } from './release-cohort.mjs';
async function confirm(directory, component, versionId, attempts = 12) {
  const cohort = checkedCohort(directory);
  const journal = load(join(directory, 'activation.json'));
  const origin = component === 'rusty' ? journal.nativeOrigin : component === 'automation'
    ? 'https://automation.meta-uber-engineer.dev' : 'https://match.meta-uber-engineer.dev';
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const health = await getJson(`${origin}/health`);
      verifyComponentObservation(cohort.components[component], health, cohort.cohortId);
      if (health.sdkSha !== cohort.components[component].sdkSha || (versionId && health.versionId !== versionId)) throw new Error('Provider version or SDK artifact mismatch');
      if (component === 'rusty') {
        const discovery = await getJson(`${origin}/.well-known/mesh-lighthouse`);
        assertCohortCapabilities(discovery.capabilities, cohort.contract.capabilities.rusty);
        if ((discovery.capabilities?.writerPolicy?.maximumWriterVersion ?? 0) < cohort.contract.minimumWriterVersion) throw new Error('Rusty cannot enforce the cohort writer version');
      }
      if (component === 'automation') {
        const capabilities = await getJson(`${origin}/v2/capabilities`);
        assertCohortCapabilities(capabilities, cohort.contract.capabilities.automation);
      }
      assertCompatibleRollback({ readers: health.readers }, cohort.contract.readers[component]);
      if (component !== 'rusty' && health.writerVersion !== cohort.components[component].writerVersion) throw new Error('Running Worker writer support differs from checked artifact');
      journal.components[component] = { ...journal.components[component], state: 'confirmed', observation: health };
      save(join(directory, 'activation.json'), journal);
      return health;
    } catch (error) { lastError = error; }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 5000));
  }
  throw lastError;
}
async function activate(directory, component) {
  assertImplementationGate(load('release/implementation-gate.json'));
  if (!['rusty', 'automation', 'frontend'].includes(component)) throw new Error('Unexpected release component');
  const cohort = checkedCohort(directory);
  const journal = load(join(directory, 'activation.json'));
  const before = component === 'rusty' ? [] : component === 'automation' ? ['rusty'] : ['rusty', 'automation'];
  if (before.some(name => journal.components[name].state !== 'confirmed')) throw new Error('Compatible server components must confirm before activation');
  if (component !== 'rusty' && !journal.components[component]?.versionId) throw new Error('No exact staged provider version');
  journal.state = 'activating'; journal.components[component].state = 'activating';
  save(join(directory, 'activation.json'), journal);
  if (component === 'rusty') {
    const receipt = deployRustyArtifact(cohort.components.rusty, cohort.cohortId);
    journal.components.rusty.hostReceipt = receipt;
    save(join(directory, 'activation.json'), journal);
  } else {
    const args = ['versions', 'deploy', '--config', join(directory, 'deploy', `${component}.json`), `${journal.components[component].versionId}@100`, '--yes'];
    if (component === 'automation') args.push('--durable-objects-code-update-mode', 'immediate');
    execFileSync(resolve('workers', 'frontend', 'node_modules', '.bin', 'wrangler'), args, { stdio: 'inherit', timeout: 300000 });
  }
  await confirm(directory, component, journal.components[component].versionId);
}
async function complete(directory) {
  assertImplementationGate(load('release/implementation-gate.json'));
  const cohort = checkedCohort(directory);
  let journal = load(join(directory, 'activation.json'));
  for (const component of ['rusty', 'automation', 'frontend']) await confirm(directory, component, journal.components[component].versionId);
  const publicState = await getJson('https://match.meta-uber-engineer.dev/release-cohort.json');
  if (publicState.cohortId !== cohort.cohortId) throw new Error('Frontend did not publish the confirmed cohort');
  for (const [path, checksum] of Object.entries(cohort.components.frontend.files)) {
    if (!path.startsWith('assets/')) continue;
    if (path.slice(7).split('/').some(part => part.startsWith('.'))) continue;
    const response = await fetch(`https://match.meta-uber-engineer.dev/${path.slice(7)}`, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Deployed asset unavailable: ${path}`);
    const { createHash } = await import('node:crypto');
    if (createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') !== checksum) throw new Error(`Deployed frontend bytes differ: ${path}`);
  }
  journal = load(join(directory, 'activation.json'));
  journal.state = 'active';
  save(join(directory, 'activation.json'), journal);
}
async function assertActivationWindow(directory) {
  const cohort = checkedCohort(directory), journal = load(join(directory, 'activation.json'));
  const response = await fetch('https://match.meta-uber-engineer.dev/release-cohort.json', { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (response.ok) {
    const active = await response.json();
    if (![cohort.cohortId, journal.previousCohort?.cohortId].filter(Boolean).includes(active.cohortId)) throw new Error('Production has another cohort; refuse stale recovery');
  } else {
    if (journal.previousCohort || ![404, 503].includes(response.status)) throw new Error('Cannot establish recovery activation window');
    const active = await productionReleaseManifest();
    if (![journal.previousManifestSha256, hashManifest(load(join(directory, 'frontend/assets/release.json')))].includes(hashManifest(active))) throw new Error('Production changed after the archived activation');
  }
}
function resetDeployConfigs(directory, cohort) {
  mkdirSync(join(directory, 'deploy'), { recursive: true });
  for (const component of ['frontend', 'automation']) save(join(directory, 'deploy', `${component}.json`),
    deployConfig(cohort.components[component], cohort, load(join(directory, component, 'wrangler.json')), component));
}
export async function prepareResume(directory, provenance) {
  assertImplementationGate(load('release/implementation-gate.json'));
  const cohort = checkedCohort(directory), journal = load(join(directory, 'activation.json'));
  if (parseRustyDeploySpec(process.env.RUSTY_DEPLOY_SPEC).origin !== journal.nativeOrigin) throw new Error('Recovery host differs from captured native origin');
  await assertActivationWindow(directory);
  resetDeployConfigs(directory, cohort);
  journal.recovery = { mode: 'resume', provenance };
  journal.deploymentRunId = process.env.GITHUB_RUN_ID; journal.deploymentRunAttempt = process.env.GITHUB_RUN_ATTEMPT;
  save(join(directory, 'activation.json'), journal);
}
export async function prepareRollback(currentDirectory, targetDirectory, directory, provenance) {
  assertImplementationGate(load('release/implementation-gate.json'));
  checkedCohort(currentDirectory); checkedCohort(targetDirectory);
  await assertActivationWindow(currentDirectory);
  const currentJournal = load(join(currentDirectory, 'activation.json'));
  const targetJournal = load(join(targetDirectory, 'activation.json'));
  if (targetJournal.state !== 'active' || ['frontend', 'automation'].some(component => !targetJournal.components[component]?.versionId)) throw new Error('Rollback target must be a previously confirmed exact deployment');
  const host = parseRustyDeploySpec(process.env.RUSTY_DEPLOY_SPEC);
  if (host.origin !== currentJournal.nativeOrigin || host.origin !== targetJournal.nativeOrigin) throw new Error('Rollback host differs from captured native origin');
  const { current, target, selected } = materializeRollback(currentDirectory, targetDirectory, directory);
  const contract = structuredClone(target.contract);
  contract.minimumWriterVersion = Math.max(current.contract.minimumWriterVersion, target.contract.minimumWriterVersion);
  for (const component of ['frontend', 'automation', 'rusty']) {
    contract.readers[component] = { ...target.contract.readers[component] };
    for (const [schema, floor] of Object.entries(current.contract.readers[component])) contract.readers[component][schema] = Math.max(contract.readers[component][schema] ?? 0, floor);
  }
  contract.capabilities = current.contract.capabilities;
  contract.migrations = [...new Set([...current.contract.migrations, ...target.contract.migrations])];
  contract.rollbackReaders = Object.values(selected).map(({ component, artifactSha256, readers, writerVersion }) => ({ component, artifactSha256, readers, writerVersion }));
  const cohort = assembleCohort(selected, contract);
  save(join(directory, 'cohort.json'), cohort);
  resetDeployConfigs(directory, cohort);
  save(join(directory, 'activation.json'), { kind: 'tincanban-release-activation', version: 1, cohortId: cohort.cohortId, state: 'prepared',
    verifiedRunId: targetJournal.verifiedRunId, verifiedRunAttempt: targetJournal.verifiedRunAttempt,
    deploymentRunId: process.env.GITHUB_RUN_ID, deploymentRunAttempt: process.env.GITHUB_RUN_ATTEMPT,
    sourceSha: selected.frontend.sourceSha, nativeOrigin: host.origin, previousCohort: publicCohort(current), previousSha: current.components.frontend.sourceSha,
    recovery: { mode: 'rollback', provenance, selectedCohortId: target.cohortId,
      originalProviderVersions: Object.fromEntries(['frontend', 'automation'].map(component => [component, targetJournal.components[component].versionId])) },
    components: { rusty: { state: 'prepared' }, automation: { state: 'prepared' }, frontend: { state: 'prepared' } } });
}
async function resume(directory) {
  assertImplementationGate(load('release/implementation-gate.json'));
  await assertActivationWindow(directory);
  await resumeStages({
    confirm: component => confirm(directory, component, load(join(directory, 'activation.json')).components[component].versionId, 1),
    activate: component => activate(directory, component),
    complete: () => complete(directory),
  });
}
export async function resumeStages(ports) {
  for (const component of ['rusty', 'automation', 'frontend']) {
    try { await ports.confirm(component); }
    catch { await ports.activate(component); }
  }
  await ports.complete();
}
async function main() {
  const [command, path, value, extra] = process.argv.slice(2);
  if (command === 'rusty-revision') console.log(rustyRevision());
  else if (command === 'prepare') await prepare(resolve(path), value);
  else if (command === 'record-version') recordVersion(resolve(path), value, extra);
  else if (command === 'activate') await activate(resolve(path), value);
  else if (command === 'complete') await complete(resolve(path));
  else if (command === 'resume') await resume(resolve(path));
  else if (command === 'source-sha') console.log(checkedCohort(resolve(path)).components.frontend.sourceSha);
  else if (command === 'needs-stage') {
    checkedCohort(resolve(path));
    if (!['frontend', 'automation'].includes(value)) throw new Error('Unexpected Worker component');
    console.log(load(join(resolve(path), 'activation.json')).components[value].versionId ? 'false' : 'true');
  }
  else throw new Error('Use rusty-revision, prepare, record-version, needs-stage, activate, resume or complete');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
