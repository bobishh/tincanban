import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJobPage } from '../src/extraction.ts';

test('Given JobPosting JSON-LD and supplied company, when extracted, then supplied field wins', async () => {
  const html = '<script type="application/ld+json">{"@type":"JobPosting","title":"Staff Engineer","hiringOrganization":{"name":"From page"},"description":"Build systems"}</script>';
  const result = await extractJobPage('https://jobs.example.test/opening', { company: 'Supplied' }, async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
  assert.equal(result.company, 'Supplied');
  assert.equal(result.role, 'Staff Engineer');
});

test('Given original JobPosting JSON-LD, when it contains an explicit identifier, then retain only a bounded declared identifier value', async () => {
  const withString = '<script type="application/ld+json">{"@type":"JobPosting","title":"Staff Engineer","identifier":"REQ-42"}</script>';
  const stringResult = await extractJobPage('https://jobs.example.test/opening', {}, async () => new Response(withString,
    { headers: { 'content-type': 'text/html' } }));
  assert.equal(stringResult.atsId, 'REQ-42');

  const withPropertyValue = '<script type="application/ld+json">{"@type":"JobPosting","title":"Staff Engineer","identifier":{"@type":"PropertyValue","propertyID":"ATS requisition","value":"REQ-43"}}</script>';
  const propertyResult = await extractJobPage('https://jobs.example.test/opening', {}, async () => new Response(withPropertyValue,
    { headers: { 'content-type': 'text/html' } }));
  assert.equal(propertyResult.atsId, 'REQ-43');

  const untypedValue = '<script type="application/ld+json">{"@type":"JobPosting","title":"Staff Engineer","identifier":{"value":"not-a-declared-property-value"}}</script>';
  const untypedResult = await extractJobPage('https://jobs.example.test/opening', {}, async () => new Response(untypedValue,
    { headers: { 'content-type': 'text/html' } }));
  assert.equal(untypedResult.atsId, undefined);

  const oversized = '<script type="application/ld+json">{"@type":"JobPosting","title":"Staff Engineer","identifier":"' + 'R'.repeat(257) + '"}</script>';
  const oversizedResult = await extractJobPage('https://jobs.example.test/opening', {}, async () => new Response(oversized,
    { headers: { 'content-type': 'text/html' } }));
  assert.equal(oversizedResult.atsId, undefined);
});

test('Given a private IP URL, when extracted, then rejects before fetching', async () => {
  await assert.rejects(extractJobPage('https://127.0.0.1/admin', {}, async () => { throw new Error('must not fetch'); }));
});

test('Given a redirect to a private host, when extracted, then rejects before following it', async () => {
  let calls = 0;
  await assert.rejects(extractJobPage('https://jobs.example.test/opening', {}, async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: 'https://localhost/admin' } });
  }));
  assert.equal(calls, 1);
});
