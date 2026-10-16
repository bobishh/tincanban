import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const repository = 'ghcr.io/bobishh/tincanban-executor';
const digest = /^sha256:[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const runtimeKeys = [
  'EXECUTOR_SERVICE_TOKEN', 'EXECUTOR_MIGRATION_SECRET', 'CLASSIFICATION_SERVICE_TOKEN',
  'IDENTITY_STORAGE_SECRET', 'EVENT_STORAGE_SECRET', 'INTEGRATIONS_JSON', 'EMAIL_ROUTES_JSON',
  'EXECUTOR_PRODUCERS_JSON', 'TELEMETRY_TOKEN',
];

export function parseRuntimeEnvironment(raw) {
  let input;
  try { input = JSON.parse(raw ?? 'null'); }
  catch { throw new Error('Executor runtime configuration must be valid JSON'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Executor runtime configuration must be a JSON object');
  for (const [key, value] of Object.entries(input)) {
    if (!runtimeKeys.includes(key)) throw new Error(`Unsupported executor runtime key: ${key}`);
    if (typeof value !== 'string') throw new Error(`Executor runtime ${key} must be a string`);
    if (/[\r\n\0]/.test(value)) throw new Error(`Executor runtime ${key} must be single-line`);
  }
  return input;
}

export function validateDeploymentPin(pin) {
  if (pin?.repository !== 'https://tangled.org/bobishh.bsky.social/hetzner_kamal' || !revision.test(pin.commit ?? '') ||
      pin.path !== 'config/deploy.tincanban-executor.yml' || pin.origin !== 'https://executor.meta-uber-engineer.dev') {
    throw new Error('Deployment requires the pinned executor configuration');
  }
  return pin;
}

export function validateArtifact(artifact, sourceSha, sdkSha) {
  if (artifact?.component !== 'tincanban-executor' || !revision.test(artifact.sourceSha ?? '') || !revision.test(artifact.sdkSha ?? '') ||
      artifact.sourceSha !== sourceSha || artifact.sdkSha !== sdkSha || !hash.test(artifact.artifactSha256 ?? '') ||
      !digest.test(artifact.imageId ?? '') || !hash.test(artifact.archiveSha256 ?? '')) {
    throw new Error('Release does not match the checked executor artifact');
  }
  return artifact;
}

export function assertExecutorImageReceipt(receipt, artifact, image) {
  if (!digest.test(receipt?.containerImageId ?? '') || receipt.configImageId !== artifact.imageId ||
      !Array.isArray(receipt.repoDigests) || !receipt.repoDigests.includes(image)) {
    throw new Error('Running executor image differs from the checked image');
  }
  return receipt;
}

/** Failure restores the captured writer; callers must finish image preparation first. */
export async function activateExecutor(ports) {
  try {
    await ports.stopPrevious();
    await ports.activate();
    return await ports.verify();
  } catch (error) {
    try { await ports.restore(); }
    catch (restoreError) { throw new AggregateError([error, restoreError], 'Executor activation and restoration failed'); }
    throw error;
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}
function fileHash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function quoted(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

function seal(output, sourceSha, sdkSha) {
  const artifact = JSON.parse(readFileSync(join(output, 'artifact.json'), 'utf8'));
  const imageId = run('docker', ['image', 'inspect', '--format', '{{.Id}}', 'tincanban-executor:checked']).trim();
  const evidence = validateArtifact({ ...artifact, imageId, archiveSha256: fileHash(join(output, 'image.tar')) }, sourceSha, sdkSha);
  writeFileSync(join(output, 'release.json'), JSON.stringify(evidence, null, 2));
}

function fetchConfiguration(pin, workspace) {
  const checkout = join(workspace, '.release-config', 'executor');
  if (existsSync(checkout)) throw new Error('Refusing to overwrite an existing executor configuration checkout');
  const options = { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, timeout: 120000 };
  const git = args => run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args], options);
  git(['init', '--quiet', checkout]);
  git(['-C', checkout, 'fetch', '--depth=1', '--no-tags', '--', pin.repository, pin.commit]);
  if (git(['-C', checkout, 'rev-parse', 'FETCH_HEAD^{commit}']).trim() !== pin.commit) throw new Error('Executor configuration differs from its pin');
  git(['-C', checkout, 'checkout', '--quiet', '--detach', pin.commit]);
  return checkout;
}

function prepareConfig(source, keyFile) {
  if (!/^service: tincanban-executor$/m.test(source) || !/^image: ["']?bobishh\/tincanban-executor["']?$/m.test(source) ||
      !/^  - tincanban_executor_data:\/data$/m.test(source) || /^accessories:$/m.test(source) || /^ssh:$/m.test(source)) {
    throw new Error('Pinned configuration must deploy only the executor and its existing volume');
  }
  return `${source}\nssh:\n  keys:\n    - ${JSON.stringify(keyFile)}\n  keys_only: true\n`;
}

function publishImage(artifact, version) {
  const alias = `${repository}:${version}`;
  let existing;
  try { existing = JSON.parse(run('docker', ['manifest', 'inspect', alias])); }
  catch (error) {
    if (!/manifest unknown|manifest not found|name unknown|no such manifest/i.test(String(error.stderr ?? ''))) throw error;
  }
  if (existing && existing.config?.digest !== artifact.imageId) throw new Error('Immutable executor release tag already identifies another image');
  run('docker', ['tag', artifact.imageId, alias]);
  const pushed = run('docker', ['push', alias], { timeout: 300000 });
  const match = pushed.match(/digest: (sha256:[a-f0-9]{64})/);
  if (!match) throw new Error('Registry did not return an executor image digest');
  return `${repository}@${match[1]}`;
}

async function liveHealth(origin, artifact) {
  const response = await fetch(`${origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Executor health returned ${response.status}`);
  const health = await response.json();
  if (health.status !== 'ready' || health.component !== artifact.component || health.sourceSha !== artifact.sourceSha ||
      health.sdkSha !== artifact.sdkSha || health.artifactSha256 !== artifact.artifactSha256) {
    throw new Error('Active executor does not match its checked source, SDK and runtime bytes');
  }
  return health;
}

async function deploy(output, sourceSha, sdkSha) {
  const artifact = validateArtifact(JSON.parse(readFileSync(join(output, 'release.json'), 'utf8')), sourceSha, sdkSha);
  if (fileHash(join(output, 'image.tar')) !== artifact.archiveSha256) throw new Error('Checked executor image archive changed');
  const pin = validateDeploymentPin(JSON.parse(readFileSync(join(directory, 'deployment-config.json'), 'utf8')));
  const host = process.env.EXECUTOR_HOST, token = process.env.GH_TOKEN;
  const keyFile = resolve(process.env.EXECUTOR_SSH_KEY_FILE ?? '');
  if (!/^[A-Za-z0-9.-]+$/.test(host ?? '') || !token || !process.env.EXECUTOR_SSH_KEY_FILE || !existsSync(keyFile)) {
    throw new Error('Executor-only host, SSH key and package credentials are required');
  }
  const runtime = parseRuntimeEnvironment(process.env.EXECUTOR_RUNTIME_ENV);
  runtime.TELEMETRY_TOKEN ??= process.env.AUTOMATION_TELEMETRY_TOKEN || '';
  for (const key of runtimeKeys.filter(key => !['EMAIL_ROUTES_JSON', 'TELEMETRY_TOKEN'].includes(key))) {
    if (!runtime[key]) throw new Error(`Executor runtime ${key} is required`);
  }
  // Register individual values too: GitHub masks the JSON envelope by default.
  for (const value of Object.values(runtime)) if (value.length >= 4) process.stdout.write(`::add-mask::${value.replaceAll('%', '%25')}\n`);
  run('docker', ['load', '--input', join(output, 'image.tar')], { timeout: 300000 });
  if (run('docker', ['image', 'inspect', '--format', '{{.Id}}', artifact.imageId]).trim() !== artifact.imageId) throw new Error('Loaded executor image differs from the checked image');
  run('docker', ['login', 'ghcr.io', '--username', process.env.GITHUB_ACTOR ?? 'github-actions', '--password-stdin'], { input: `${token}\n` });
  const version = `release-${artifact.imageId.slice('sha256:'.length)}`;
  const attempt = `${process.env.GITHUB_RUN_ID ?? ''}-${process.env.GITHUB_RUN_ATTEMPT ?? ''}`;
  if (!/^[1-9][0-9]*-[1-9][0-9]*$/.test(attempt)) throw new Error('Executor handoff requires an exact workflow run and attempt');
  const handoffId = createHash('sha256').update(`${artifact.imageId}\0${attempt}`).digest('hex');
  const image = publishImage(artifact, version);
  const checkout = fetchConfiguration(pin, resolve(process.env.GITHUB_WORKSPACE ?? process.cwd()));
  const config = join(checkout, 'config', '.deploy.executor.yml');
  const secretsFile = join(checkout, '.kamal', 'secrets');
  mkdirSync(dirname(secretsFile), { recursive: true, mode: 0o700 });
  writeFileSync(secretsFile, `${runtimeKeys.map(key => `${key}=$${key}`).join('\n')}\n`, { mode: 0o600, flag: 'wx' });
  writeFileSync(config, prepareConfig(readFileSync(join(checkout, pin.path), 'utf8'), keyFile), { mode: 0o600, flag: 'wx' });
  const env = { ...process.env, ...Object.fromEntries(runtimeKeys.map(key => [key, runtime[key] ?? ''])),
    SERVER_IP: host, VERSION: version, DOCKER_REGISTRY_USERNAME: 'bobishh', DOCKER_REGISTRY_PASSWORD: token };
  const options = { cwd: checkout, env, timeout: 900000, stdio: 'inherit' };
  const configArgs = ['--skip-hooks', '--version', version, '--config-file', config];
  const ssh = (command, input) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20', '-i', keyFile, `root@${host}`, command], { input, timeout: 180000 });
  const handoff = action => JSON.parse(ssh(`python3 - ${quoted(action)} ${quoted(handoffId)}`, readFileSync(join(directory, 'storageHandoff.py'), 'utf8')).trim().split('\n').at(-1));
  const verifyImage = () => {
    const name = `tincanban-executor-web-${version}`;
    const receipt = JSON.parse(ssh(`python3 - ${quoted(name)} ${quoted(artifact.imageId)}`, readFileSync(join(directory, 'imageReceipt.py'), 'utf8')).trim().split('\n').at(-1));
    return assertExecutorImageReceipt(receipt, artifact, image);
  };
  try {
    run('kamal', ['build', 'pull', ...configArgs], options);
    // Retrying a completed release must not stop its only healthy writer.
    let alreadyActive = false;
    try { verifyImage(); await liveHealth(pin.origin, artifact); alreadyActive = true; } catch { /* Deployment below establishes the requested release. */ }
    const receipt = alreadyActive ? verifyImage() : await activateExecutor({
      stopPrevious: () => handoff('stop'),
      activate: () => run('kamal', ['deploy', '--skip-push', ...configArgs], options),
      verify: async () => { const result = verifyImage(); await liveHealth(pin.origin, artifact); return result; },
      restore: async () => {
        const previous = handoff('restore');
        if (previous.version !== null) {
          if (!/^[A-Za-z0-9_.-]+$/.test(previous.version)) throw new Error('Invalid captured executor version');
          run('kamal', ['app', 'start', '--skip-hooks', '--version', previous.version, '--config-file', config], options);
        }
      },
    });
    writeFileSync(join(output, 'deployment.json'), JSON.stringify({ ...artifact, image, configSha: pin.commit, origin: pin.origin, ...receipt }, null, 2));
  } finally {
    unlinkSync(config);
    unlinkSync(secretsFile);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, output, sourceSha, sdkSha] = process.argv.slice(2);
  if (command === 'seal') seal(resolve(output), sourceSha, sdkSha);
  else if (command === 'deploy') await deploy(resolve(output), sourceSha, sdkSha);
  else throw new Error('Usage: deploy.mjs seal|deploy <artifact-directory> <source-sha> <sdk-sha>');
}
