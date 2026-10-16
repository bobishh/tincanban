import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256Base64Url } from '../../../src/domain/identityCrypto';
import { prepareItemCommand } from '../src/itemCommands.ts';

const opportunity = {
  relevance: 'yes',
  assessment: { version: 1, employee_profile: { stack: '', work_profile: '' },
    scores: { companyRecognition: null, companyStability: null, stackFit: null, workFit: null } },
  assessmentDistributions: Object.fromEntries(['companyRecognition', 'companyStability', 'stackFit', 'workFit'].map(key => [key, {
    type: 'choice', choice: 'unknown', confidence: 1, probabilities: { strong: 0, partial: 0, weak: 0, unknown: 1 },
  }])),
  priority: { score: 0, optionId: 'p3' },
  roleType: 'backend', seniority: 'senior',
  distributions: {
    job_opportunity: { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1, no: 0, uncertain: 0 } },
    role_type: { type: 'choice', choice: 'backend', confidence: 1,
      probabilities: { backend: 1, frontend: 0, fullstack: 0, platform_devops: 0, data_ai: 0, mobile: 0, engineering_management: 0, other_unknown: 0 } },
    seniority: { type: 'choice', choice: 'senior', confidence: 1,
      probabilities: { intern_junior: 0, middle: 0, senior: 1, staff_principal: 0, lead_manager: 0, unknown: 0 } },
  },
  model: '@cf/cloudflare/clef-flash', policyVersion: 'lead-clef-v2',
};

const envelope = async () => {
  const value = {
    integrationId: 'integration-1', sourceEventId: 'A'.repeat(43), idempotencyKey: '',
    event: { source: 'website', receivedAt: '2026-10-16T12:00:00.000Z',
      submission: { company: 'Example', role: 'Engineer', contact: '', message: 'A role', jobUrl: 'https://example.com/jobs/1' } },
    classification: { status: 'review', reason: 'Needs approval', source: { type: 'website', receivedAt: '2026-10-16T12:00:00.000Z' },
      decision: opportunity },
  };
  value.idempotencyKey = await sha256Base64Url(new TextEncoder().encode(JSON.stringify(value.event.submission)));
  return value;
};

test('Given the same integration and source event, when a normalized command is prepared again, then it keeps a stable event identity and payload digest', async () => {
  const first = await prepareItemCommand(await envelope(), 'integration-1');
  const second = await prepareItemCommand(await envelope(), 'integration-1');
  assert.equal(first.eventId, second.eventId);
  assert.equal(first.bodyHash, second.bodyHash);
  assert.equal(first.sourceId, first.eventId);
});

test('Given a command with changed evidence or a mismatched integration, when normalized, then changed bytes change the digest and cross-integration submission is rejected', async () => {
  const first = await prepareItemCommand(await envelope(), 'integration-1');
  const changed = await envelope();
  changed.event.submission.message = 'Changed source evidence';
  changed.idempotencyKey = await sha256Base64Url(new TextEncoder().encode(JSON.stringify(changed.event.submission)));
  assert.notEqual((await prepareItemCommand(changed, 'integration-1')).bodyHash, first.bodyHash);
  await assert.rejects(prepareItemCommand({ ...(await envelope()), integrationId: 'integration-2' }, 'integration-1'));
});

test('Given caller-supplied scores that disagree with CLEF probability evidence, when a command is normalized, then it is rejected', async () => {
  const forged = await envelope();
  forged.classification.decision = { ...opportunity, priority: { score: 10, optionId: 'p0' } };
  await assert.rejects(prepareItemCommand(forged, 'integration-1'));
});

test('Given an owner-attention email with no decision, when normalized, then it remains a non-authoring review command', async () => {
  const rawMime = btoa('From: jobs@example.com\r\nSubject: Confirm forwarding\r\n\r\nConfirm address');
  const event = { source: 'email', receivedAt: '2026-10-16T12:00:00.000Z', rawMime,
    message: { messageId: null, inReplyTo: null, references: [], from: 'jobs@example.com', to: 'owner@example.com',
      subject: 'Confirm forwarding', text: 'Confirm address', date: null, urls: [], confirmation: true, attachments: [] } } as const;
  const value = { integrationId: 'integration-1', sourceEventId: 'B'.repeat(43),
    idempotencyKey: await sha256Base64Url(Uint8Array.from(atob(rawMime), character => character.charCodeAt(0))), event,
    classification: { status: 'review', reason: 'Forwarding confirmation requires owner attention',
      source: { type: 'email', receivedAt: event.receivedAt, messageId: null } } };

  const prepared = await prepareItemCommand(value, 'integration-1');

  assert.equal(prepared.classification.status, 'review');
  assert.equal(prepared.classification.decision, undefined);
  assert.equal(prepared.classification.opportunity, undefined);
});

test('Given a malformed present decision or an opportunity without its source decision, when normalized, then it is rejected', async () => {
  const malformed = await envelope();
  malformed.classification.decision = { event: 'applied' };
  await assert.rejects(prepareItemCommand(malformed, 'integration-1'));

  const missingDecision = await envelope();
  missingDecision.classification.decision = undefined;
  missingDecision.classification.opportunity = opportunity;
  await assert.rejects(prepareItemCommand(missingDecision, 'integration-1'), /requires a decision/i);
});
