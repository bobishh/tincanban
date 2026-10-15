import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const sourceImagePattern = /^ghcr\.io\/bobishh\/rusty@sha256:[a-f0-9]{64}$/;

export function parseRustyDeploySpec(raw) {
  const spec = JSON.parse(raw ?? 'null');
  if (!spec || spec.kind !== 'kamal' || !/^\.release-config\/[A-Za-z0-9_-]+$/.test(spec.directory ?? '') ||
    spec.configFile !== 'config/deploy.mesh-lighthouse.yml' || !/^[a-f0-9]{40}$/.test(spec.configSha ?? '') ||
    !/^[A-Za-z0-9.-]+$/.test(spec.server ?? '') || !/^https:\/\/[^/]+$/.test(spec.origin ?? '')) {
    throw new Error('Configure the exact existing Rusty Kamal deployment before activation');
  }
  return spec;
}

export function rustyCohortTag(cohortId) {
  if (!/^[a-f0-9]{64}$/.test(cohortId ?? '')) throw new Error('Invalid release cohort identity');
  return `cohort-${cohortId}`;
}

export function kamalImageConfig(source, repository, keyFile) {
  if (!/^ghcr\.io\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Invalid sealed Rusty image repository');
  const imageLine = /^image: "<%= ENV\['DOCKER_REGISTRY_USERNAME'\] %>\/mesh-lighthouse"$/gm;
  const matches = [...source.matchAll(imageLine)];
  if (matches.length !== 1 || !/^service: mesh-lighthouse$/m.test(source) ||
    !/^proxy:$/m.test(source) || !/^accessories:$/m.test(source) ||
    !/^volumes:\n  - mesh_lighthouse_blind_20261008:\/data$/m.test(source) ||
    !/^  clickhouse:$/m.test(source)) throw new Error('Pinned Rusty Kamal config differs from the preserved production service');
  let config = source.replace(imageLine, `image: "${repository.slice('ghcr.io/'.length)}"`);
  if (keyFile) {
    if (!/^\/[A-Za-z0-9_./-]+$/.test(keyFile) || keyFile.split('/').includes('..') || /^ssh:$/m.test(config)) {
      throw new Error('Kamal deployment requires a safe SSH key path and no conflicting SSH config');
    }
    config += `\nssh:\n  keys:\n    - ${JSON.stringify(keyFile)}\n  keys_only: true\n`;
  }
  return config;
}

export function parseImageDigest(output) {
  const match = String(output).match(/^Digest:\s*(sha256:[a-f0-9]{64})\s*$/m);
  if (!match) throw new Error('Registry did not report an exact image digest');
  return match[1];
}

export function assertRustyRuntimeImageReceipt(receipt, artifact) {
  const expectedDigest = artifact.image.slice(artifact.image.indexOf('@') + 1);
  if (receipt.image !== artifact.image || !/^sha256:[a-f0-9]{64}$/.test(receipt.containerImageId ?? '') ||
    !Array.isArray(receipt.repoDigests) || !receipt.repoDigests.includes(`ghcr.io/bobishh/rusty@${expectedDigest}`)) {
    throw new Error('Kamal host did not confirm the sealed Rusty image digest');
  }
  return receipt;
}

function defaultRun(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

function notFound(error) {
  const detail = String(error?.stderr ?? '');
  return /manifest unknown|manifest not found|name unknown|not found/i.test(detail);
}

function inspectDigest(run, reference) {
  return parseImageDigest(run('docker', ['buildx', 'imagetools', 'inspect', reference]));
}

function ensureCohortAlias(run, artifact, cohortId) {
  const sourceDigest = artifact.image.slice(artifact.image.indexOf('@') + 1);
  if (!digestPattern.test(sourceDigest) || inspectDigest(run, artifact.image) !== sourceDigest) {
    throw new Error('Sealed Rusty image reference does not resolve to its recorded digest');
  }
  const repository = artifact.image.slice(0, artifact.image.indexOf('@'));
  const alias = `${repository}:${rustyCohortTag(cohortId)}`;
  let aliasDigest;
  try { aliasDigest = inspectDigest(run, alias); }
  catch (error) {
    if (!notFound(error)) throw new Error('Cannot establish the existing Rusty cohort image tag');
  }
  if (aliasDigest && aliasDigest !== sourceDigest) throw new Error('Rusty cohort image tag already names another sealed artifact');
  if (!aliasDigest) {
    run('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', alias, artifact.image]);
    aliasDigest = inspectDigest(run, alias);
  }
  if (aliasDigest !== sourceDigest) throw new Error('Rusty cohort image tag changed during publication');
  return { alias, sourceDigest };
}

function verifyOnHost(run, spec, version, artifact) {
  const keyArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
  if (process.env.RUSTY_SSH_KEY_FILE) keyArgs.push('-i', process.env.RUSTY_SSH_KEY_FILE);
  const script = `set -eu\nname="$1"\ncontainer=$(docker inspect --format '{{.Id}}' "$name")\nimage_id=$(docker inspect --format '{{.Image}}' "$container")\nrepo_digests=$(docker image inspect --format '{{json .RepoDigests}}' "$image_id")\nprintf '{"image":"%s","containerImageId":"%s","repoDigests":%s}\\n' "$2" "$image_id" "$repo_digests"\n`;
  const name = `mesh-lighthouse-web-${version}`;
  const remote = ['sh', '-s', '--', name, artifact.image].map(value => `'${String(value).replaceAll("'", "'\\''")}'`).join(' ');
  const output = run('ssh', [...keyArgs, `root@${spec.server}`, remote], { input: script, timeout: 60000 });
  const receipt = JSON.parse(output.trim().split('\n').at(-1));
  return assertRustyRuntimeImageReceipt(receipt, artifact);
}

export function deployRustyArtifact(artifact, cohortId, rawSpec = process.env.RUSTY_DEPLOY_SPEC, ports = {}) {
  const spec = parseRustyDeploySpec(rawSpec);
  if (!sourceImagePattern.test(artifact.image ?? '') || !digestPattern.test(`sha256:${artifact.binarySha256 ?? ''}`) ||
    !/^[a-f0-9]{40}$/.test(artifact.sourceSha ?? '') || !/^[a-f0-9]{40}$/.test(artifact.sdkSha ?? '')) {
    throw new Error('Unsealed native deployment request');
  }
  const version = rustyCohortTag(cohortId);
  const repository = artifact.image.slice(0, artifact.image.indexOf('@'));
  const infraDirectory = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd(), spec.directory);
  const run = ports.run ?? defaultRun;
  const actualConfigSha = run('git', ['-C', infraDirectory, 'rev-parse', 'HEAD']).trim();
  if (actualConfigSha !== spec.configSha) throw new Error('Rusty Kamal configuration checkout differs from the captured commit');
  const baseConfig = join(infraDirectory, spec.configFile);
  const temporaryConfig = join(infraDirectory, 'config', `.deploy.mesh-lighthouse.${version}.yml`);
  const originalConfig = ports.readConfig ? ports.readConfig(baseConfig) : readFileSync(baseConfig, 'utf8');
  const pinnedConfig = run('git', ['-C', infraDirectory, 'show', `${spec.configSha}:${spec.configFile}`]);
  if (pinnedConfig !== originalConfig) throw new Error('Rusty Kamal config file differs from its pinned commit');
  const deployedConfig = kamalImageConfig(originalConfig, repository, process.env.RUSTY_SSH_KEY_FILE);
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GitHub package credentials are required for the sealed cohort image tag');
  run('docker', ['login', 'ghcr.io', '--username', process.env.GITHUB_ACTOR ?? 'github-actions', '--password-stdin'], { input: `${token}\n` });
  const { alias, sourceDigest } = ensureCohortAlias(run, artifact, cohortId);
  if (ports.writeConfig) ports.writeConfig(temporaryConfig, deployedConfig);
  else writeFileSync(temporaryConfig, deployedConfig, { flag: 'wx', mode: 0o600 });
  try {
    const environment = { ...process.env, SERVER_IP: spec.server, VERSION: version,
      DOCKER_REGISTRY_PASSWORD: process.env.DOCKER_REGISTRY_PASSWORD ?? token };
    run('kamal', ['deploy', '--skip-push', '--skip-hooks', '--version', version, '--config-file', temporaryConfig], {
      cwd: infraDirectory, env: environment, timeout: 600000, stdio: 'inherit',
    });
    const receipt = verifyOnHost(run, spec, version, artifact);
    if (!receipt.repoDigests.includes(`ghcr.io/bobishh/rusty@${sourceDigest}`)) throw new Error('Running Rusty image differs from the sealed cohort digest');
    return { image: artifact.image, cohortTag: alias, sourceDigest, ...receipt };
  } finally {
    if (ports.unlinkConfig) ports.unlinkConfig(temporaryConfig);
    else unlinkSync(temporaryConfig);
  }
}
