import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRustyDeployConfig } from './fetch-rusty-deploy-config.mjs';

const pin = { repository: 'https://tangled.org/bobishh.bsky.social/hetzner_kamal',
  commit: 'efc812ab77c00c1dcc1315668f0f1d735c4679ed' };
const spec = { kind: 'kamal', directory: '.release-config/hetzner_playground', configSha: pin.commit,
  configFile: 'config/deploy.mesh-lighthouse.yml', server: 'rusty.example', origin: 'https://rusty.example' };

test('Given the existing public Tangled config, when CI fetches deployment inputs, then use only the captured commit without GitHub config credentials', () => {
  const calls = [];
  const result = fetchRustyDeployConfig(JSON.stringify(spec), { pin, workspace: '/runner/work/app', exists: () => false,
    run: (command, args, options) => { calls.push({ command, args, options }); return args.includes('rev-parse') ? `${pin.commit}\n` : ''; } });
  assert.equal(result, '/runner/work/app/.release-config/hetzner_playground');
  const fetch = calls.find(call => call.args.includes('fetch'));
  assert.deepEqual(fetch.args.slice(-5), ['--depth=1', '--no-tags', '--', pin.repository, pin.commit]);
  assert.equal(calls.some(call => call.args.includes('checkout')), true);
  assert.equal(calls.every(call => call.command === 'git'), true);
  assert.equal(calls.every(call => call.options.env.GIT_CONFIG_GLOBAL === '/dev/null'), true);
});

test('Given a mutable or different configuration pin, when loading production inputs, then fail before creating a checkout', () => {
  for (const changed of [{ configSha: 'a'.repeat(40) }, { directory: '.release-config/../elsewhere' }]) {
    assert.throws(() => fetchRustyDeployConfig(JSON.stringify({ ...spec, ...changed }), { pin,
      run: () => { throw new Error('must not run'); }, exists: () => false }), /captured|exact existing/);
  }
  assert.throws(() => fetchRustyDeployConfig(JSON.stringify(spec), { pin: { ...pin, repository: 'https://evil.example/config' },
    run: () => { throw new Error('must not run'); }, exists: () => false }), /captured/);
});

test('Given an existing checkout or incorrect fetch result, when preparing deployment, then refuse overwrite or activation', () => {
  assert.throws(() => fetchRustyDeployConfig(JSON.stringify(spec), { pin, exists: () => true }), /already exists/);
  assert.throws(() => fetchRustyDeployConfig(JSON.stringify(spec), { pin, exists: () => false,
    run: (_command, args) => args.includes('rev-parse') ? 'a'.repeat(40) : '' }), /differs from the captured commit/);
});
