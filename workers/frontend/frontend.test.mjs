import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './frontend.mjs';

test('Given a release, when a deep link opens, then HTML stays on that URL and reports the release', async () => {
  const paths = [];
  const env = { RELEASE_SHA: 'abc', ASSETS: { fetch: async (request) => {
    paths.push(new URL(request.url).pathname);
    return paths.length === 1 ? new Response(null, { status: 404 }) : new Response('<html>board</html>', { headers: { 'content-type': 'text/html' } });
  } } };
  const result = await worker.fetch(new Request('https://match.meta-uber-engineer.dev/pair'), env);
  assert.equal(result.status, 200);
  assert.deepEqual(paths, ['/pair', '/']);
  assert.equal(result.headers.get('x-frontend-release'), 'abc');
  assert.match(result.headers.get('cache-control'), /no-store/);
});

test('Given a missing chunk, when requested, then return 404 rather than HTML', async () => {
  let calls = 0;
  const result = await worker.fetch(new Request('https://match.meta-uber-engineer.dev/assets/missing.js'), {
    ASSETS: { fetch: async () => { calls++; return new Response(null, { status: 404 }); } },
  });
  assert.equal(result.status, 404);
  assert.equal(calls, 1);
});

test('Given a health request, then report exact deployed SHA without reading assets', async () => {
  const result = await worker.fetch(new Request('https://match.meta-uber-engineer.dev/health'), { RELEASE_SHA: 'abc' });
  assert.equal(result.headers.get('x-frontend-release'), 'abc');
  assert.equal(result.headers.get('x-frontend-worker'), 'tincanban');
});

test('Given a coordinated release, when a tab checks release state, then report the artifact cohort without claiming device acknowledgement', async () => {
  const cohort = { kind: 'tincanban-release-cohort', version: 1, cohortId: 'c'.repeat(64), components: { frontend: {} }, contract: {} };
  const response = await worker.fetch(new Request('https://match.meta-uber-engineer.dev/release-cohort.json'), {
    RELEASE_COHORT_JSON: JSON.stringify(cohort), RELEASE_ARTIFACT_SHA256: 'a'.repeat(64),
    CF_VERSION_METADATA: { id: 'exact-version' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const body = await response.json();
  assert.equal(body.cohortId, cohort.cohortId);
  assert.equal(body.frontendVersionId, 'exact-version');
  assert.equal(body.deviceAcknowledged, undefined);
});

test('Given no verified cohort metadata, when a client asks about activation, then refuse a successful cohort claim', async () => {
  const response = await worker.fetch(new Request('https://match.meta-uber-engineer.dev/release-cohort.json'), {});
  assert.equal(response.status, 503);
});
