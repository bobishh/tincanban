import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertRustyRuntimeImageReceipt, deployRustyArtifact, kamalImageConfig, parseRustyDeploySpec,
  parseImageDigest, rustyCohortTag,
} from './deploy-rusty-cohort.mjs';

const cohortId = 'a'.repeat(64);
const imageDigest = 'sha256:' + 'b'.repeat(64);
const binarySha256 = 'c'.repeat(64);
const artifact = { image: `ghcr.io/bobishh/rusty@${imageDigest}`, binarySha256,
  sourceSha: 'd'.repeat(40), sdkSha: 'e'.repeat(40) };
const spec = { kind: 'kamal', directory: '.release-config/hetzner_playground', configSha: 'f'.repeat(40),
  configFile: 'config/deploy.mesh-lighthouse.yml', server: 'rusty.example', origin: 'https://rusty.example' };
const productionConfig = `service: mesh-lighthouse\nimage: "<%= ENV['DOCKER_REGISTRY_USERNAME'] %>/mesh-lighthouse"\nservers:\n  web:\n    hosts:\n      - "<%= ENV['SERVER_IP'] %>"\nproxy:\n  ssl: true\n  hosts:\n    - ingest.meta-uber-engineer.dev\nvolumes:\n  - mesh_lighthouse_blind_20261008:/data\nenv:\n  clear:\n    RUSTY_TRUSTED_OWNER: '<%= ENV.fetch("RUSTY_TRUSTED_OWNER") %>'\naccessories:\n  clickhouse:\n    image: clickhouse/clickhouse-server:26.8.11.7\n`;

test('Given a Rusty production host, when parsing deployment settings, then require the existing Kamal service and exact host origin', () => {
  assert.deepEqual(parseRustyDeploySpec(JSON.stringify(spec)), spec);
  for (const changed of [
    { kind: 'ssh-compose' }, { directory: '.release-config/../other' }, { configSha: 'mutable' },
    { configFile: 'config/deploy.other.yml' }, { server: 'host; echo bad' },
    { origin: 'http://rusty.example' },
  ]) assert.throws(() => parseRustyDeploySpec(JSON.stringify({ ...spec, ...changed })), /exact existing Rusty Kamal/);
});

test('Given the pinned production config, when selecting the sealed repository, then preserve Kamal routing, environment, volume and accessory settings byte-for-byte', () => {
  const changed = kamalImageConfig(productionConfig, 'ghcr.io/bobishh/rusty');
  assert.equal(changed, productionConfig.replace(
    `image: "<%= ENV['DOCKER_REGISTRY_USERNAME'] %>/mesh-lighthouse"`,
    'image: "bobishh/rusty"'));
  assert.match(changed, /mesh_lighthouse_blind_20261008:\/data/);
  assert.match(changed, /clickhouse:/);
  assert.match(kamalImageConfig(productionConfig, 'ghcr.io/bobishh/rusty', '/runner_temp/rusty.key'), /keys_only: true/);
  assert.throws(() => kamalImageConfig(productionConfig, 'ghcr.io/bobishh/rusty', '/tmp/../private.key'), /safe SSH key path/);
  assert.throws(() => kamalImageConfig(productionConfig.replace('clickhouse:', 'other:'), 'ghcr.io/bobishh/rusty'), /preserved production service/);
});

test('Given a sealed image, when deriving its Kamal version, then bind a unique cohort tag to the 64-character cohort seal', () => {
  assert.equal(rustyCohortTag(cohortId), `cohort-${cohortId}`);
  assert.throws(() => rustyCohortTag('short'), /cohort identity/);
  assert.equal(parseImageDigest(`Name: ghcr.io/bobishh/rusty\nDigest: ${imageDigest}\n`), imageDigest);
  assert.throws(() => parseImageDigest('Name: ghcr.io/bobishh/rusty'), /exact image digest/);
});

test('Given a digest-addressed artifact, when activating through Kamal, then alias the sealed digest and deploy with skip-push without rebuilding or booting accessories', () => {
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === 'git') return args[2] === 'show' ? productionConfig : `${spec.configSha}\n`;
    if (command === 'docker' && args[0] === 'buildx' && args[1] === 'imagetools' && args[2] === 'inspect') {
      if (args[3].endsWith(`:${rustyCohortTag(cohortId)}`) && !calls.some(call => call.command === 'docker' && call.args[2] === 'create')) {
        const error = new Error('missing tag'); error.stderr = Buffer.from('manifest unknown'); throw error;
      }
      return `Digest: ${imageDigest}\n`;
    }
    if (command === 'ssh') return JSON.stringify({ image: artifact.image, containerImageId: 'sha256:' + 'f'.repeat(64),
      repoDigests: [artifact.image] });
    return '';
  };
  const writes = [], removals = [];
  const oldToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'opaque-test-token';
  try {
    const receipt = deployRustyArtifact(artifact, cohortId, JSON.stringify(spec), {
      run, readConfig: () => productionConfig, writeConfig: (path, text) => writes.push({ path, text }),
      unlinkConfig: path => removals.push(path),
    });
    assert.equal(receipt.sourceDigest, imageDigest);
    assert.equal(receipt.cohortTag, `ghcr.io/bobishh/rusty:${rustyCohortTag(cohortId)}`);
  } finally {
    if (oldToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = oldToken;
  }
  const create = calls.find(call => call.command === 'docker' && call.args.includes('create'));
  assert.deepEqual(create.args.slice(0, 5), ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag']);
  const deploy = calls.find(call => call.command === 'kamal');
  assert.deepEqual(deploy.args.slice(0, 5), ['deploy', '--skip-push', '--skip-hooks', '--version', `cohort-${cohortId}`]);
  assert.equal(deploy.args.includes('accessory'), false);
  assert.equal(calls.some(call => call.command === 'docker' && call.args.includes('build')), false);
  assert.equal(writes.length, 1);
  assert.match(writes[0].text, /mesh_lighthouse_blind_20261008:\/data/);
  assert.deepEqual(removals, [writes[0].path]);
});

test('Given an existing cohort alias or running host with another digest, when deploying, then fail closed before trusting source health', () => {
  assert.throws(() => assertRustyRuntimeImageReceipt({ image: artifact.image,
    containerImageId: 'sha256:' + 'f'.repeat(64), repoDigests: ['ghcr.io/bobishh/rusty@sha256:' + '9'.repeat(64)] }, artifact), /sealed Rusty image digest/);
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === 'git') return args[2] === 'show' ? productionConfig : `${spec.configSha}\n`;
    if (command === 'docker' && args[0] === 'buildx' && args[2] === 'inspect') {
      return args[3].endsWith(`:${rustyCohortTag(cohortId)}`)
        ? `Digest: sha256:${'9'.repeat(64)}\n` : `Digest: ${imageDigest}\n`;
    }
    return '';
  };
  const oldToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'opaque-test-token';
  try {
    assert.throws(() => deployRustyArtifact(artifact, cohortId, JSON.stringify(spec), { run,
      readConfig: () => productionConfig, writeConfig: () => {}, unlinkConfig: () => {} }), /another sealed artifact/);
  } finally {
    if (oldToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = oldToken;
  }
  assert.equal(calls.some(call => call.command === 'kamal'), false);
});

test('Given an infra checkout with the right HEAD but edited deploy config, when activating, then reject before registry or host changes', () => {
  const calls = [];
  const oldToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'opaque-test-token';
  try {
    assert.throws(() => deployRustyArtifact(artifact, cohortId, JSON.stringify(spec), {
      readConfig: () => productionConfig,
      run: (command, args) => {
        calls.push({ command, args });
        if (command === 'git' && args[2] === 'show') return productionConfig.replace('mesh_lighthouse_blind_20261008', 'changed-volume');
        return `${spec.configSha}\n`;
      },
    }), /differs from its pinned commit/);
  } finally {
    if (oldToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = oldToken;
  }
  assert.equal(calls.some(call => call.command === 'docker'), false);
  assert.equal(calls.some(call => call.command === 'kamal'), false);
});
