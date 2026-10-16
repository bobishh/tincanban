import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateExecutor } from './migrate.mjs';

const origin = 'https://executor.meta-uber-engineer.dev';
const integrationId = 'integration-one', epoch = 2, manifestHash = 'a'.repeat(43);
const manifest = { version: 1, integrationId, origin, epoch, alarmAt: null,
  tables: [{ name: 'events', pages: [{ offset: 0 }, { offset: 1 }] }] };

function migrationFixture(failPage = false) {
  const calls = [];
  let status = { status: 'unconfigured', epoch: null, manifestHash: null };
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname, query = new URL(url).search;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, query, body });
    assert.equal(init.headers.authorization, 'Bearer private-service-token');
    if (path.endsWith('/prepare')) return Response.json({ manifest, manifestHash });
    if (path.endsWith('/migration-manifest')) { status = { status: 'importing', epoch, manifestHash }; return Response.json({ status: 'importing', epoch }); }
    if (path.endsWith('/page')) return Response.json({ table: 'events', offset: Number(new URL(url).searchParams.get('offset')), nonce: 'sealed-nonce', ciphertext: 'sealed-payload' });
    if (path.endsWith('/migration-page')) return failPage ? new Response('private event body', { status: 503 }) : Response.json({ imported: true });
    if (path.endsWith('/status')) return Response.json(status);
    if (path.endsWith('/activate')) { status = { status: 'active', epoch, manifestHash }; return Response.json(status); }
    if (path.endsWith('/ack')) return Response.json({ status: 'active', epoch, manifestHash });
    throw new Error('Unexpected fixture request');
  };
  return { calls, fetcher };
}

test('Given a frozen participant, When importing, Then sealed pages transfer sequentially without activating either writer', async () => {
  const fixture = migrationFixture();
  const result = await migrateExecutor({ action: 'import', integrationId, epoch, origin, token: 'private-service-token', fetcher: fixture.fetcher });
  assert.deepEqual(result, { status: 'importing', integrationId, epoch, tables: 1, pages: 2 });
  assert.deepEqual(fixture.calls.map(call => call.path.split('/').at(-1)), ['status', 'prepare', 'migration-manifest', 'page', 'migration-page', 'page', 'migration-page', 'status']);
  assert.equal(fixture.calls[4].body.page.ciphertext, 'sealed-payload');
});

test('Given a failed page, When importing, Then no activation or acknowledgement occurs and private response text stays out of errors', async () => {
  const fixture = migrationFixture(true);
  await assert.rejects(migrateExecutor({ action: 'import', integrationId, epoch, origin, token: 'private-service-token', fetcher: fixture.fetcher }), error => {
    assert.match(error.message, /HTTP 503/); assert.doesNotMatch(error.message, /private event body/); return true;
  });
  assert.equal(fixture.calls.some(call => /\/(activate|ack)$/.test(call.path)), false);
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/page')).length, 1);
});

test('Given an imported participant and explicit resolutions, When activating, Then Node confirms activation before intake changes its route', async () => {
  const fixture = migrationFixture();
  await migrateExecutor({ action: 'import', integrationId, epoch, origin, token: 'private-service-token', fetcher: fixture.fetcher });
  fixture.calls.length = 0;
  const manualResolutions = [{ eventId: 'already-handled-event', reason: 'Handled by owner', itemId: 'existing-card' }];
  const result = await migrateExecutor({ action: 'activate', integrationId, epoch, origin, token: 'private-service-token', manualResolutions, fetcher: fixture.fetcher });
  assert.deepEqual(result, { status: 'active', integrationId, epoch, resolvedEvents: 1 });
  assert.deepEqual(fixture.calls.map(call => call.path.split('/').at(-1)), ['status', 'activate', 'status', 'ack']);
  assert.deepEqual(fixture.calls[1].body, { epoch, manifestHash, manualResolutions });
});

test('Given no imported manifest, When activating, Then no writer or route is activated', async () => {
  const fixture = migrationFixture();
  await assert.rejects(migrateExecutor({ action: 'activate', integrationId, epoch, origin, token: 'private-service-token', manualResolutions: [], fetcher: fixture.fetcher }), /imported migration/);
  assert.equal(fixture.calls.length, 1);
});
