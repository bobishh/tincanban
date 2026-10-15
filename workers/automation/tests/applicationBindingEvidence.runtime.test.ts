import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalizeJson, resetIdentityStorageForTest, bootstrapIdentity } from '../../../src/domain/identity.ts';
import { createApplicationBinding, type ApplicationBindingInput } from '../../../src/domain/applicationBinding.ts';
import { resolveSigningContext } from '../../../src/domain/signingContext.ts';
import type { ApplicationEventClassification } from '../src/clef.ts';
import type { AutomationEvent } from '../src/pipeline.ts';
import {
  applicationBindingEventHash, decryptApplicationBindingRecord, encryptApplicationBindingRecord,
  hashApplicationBindingDecision,
} from '../src/applicationBindingEvidence.ts';

const secret = 'a sufficiently long application binding storage secret';
const rawMimeBytes = new Uint8Array([0x46, 0x72, 0x6f, 0x6d, 0x3a, 0x20, 0x72, 0x65, 0x63, 0x72, 0x75, 0x69, 0x74, 0x65, 0x72, 0x40,
  0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x74, 0x65, 0x73, 0x74, 0x0d, 0x0a, 0x0d, 0x0a, 0x59, 0x6f, 0x75, 0x72,
  0x20, 0x61, 0x70, 0x70, 0x6c, 0x69, 0x63, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x20, 0x68, 0x61, 0x73, 0x20, 0x62, 0x65, 0x65,
  0x6e, 0x20, 0x72, 0x65, 0x63, 0x65, 0x69, 0x76, 0x65, 0x64, 0x2e, 0x0d, 0x0a, 0xff, 0xfe]);
const rawMime = Buffer.from(rawMimeBytes).toString('base64url');
const mail: Extract<AutomationEvent, { source: 'email' }> = {
  source: 'email', receivedAt: '2026-10-14T10:00:00.000Z', rawMime,
  message: { messageId: '<message@example.test>', inReplyTo: null, references: [], from: 'Recruiter', to: 'Owner',
    subject: 'Application received', text: 'We received your application.', date: '2026-10-14T09:59:00Z', urls: [], confirmation: false, attachments: [] },
};
const classification: ApplicationEventClassification = {
  event: 'applied', model: '@cf/cloudflare/clef-flash', policyVersion: 'application-event-clef-v2',
  distributions: { application_event: { type: 'choice', choice: 'applied', confidence: 0.95,
    probabilities: { new_opportunity: 0, applied: 0.95, interview: 0.01, rejected: 0, offer: 0.01, follow_up: 0.01, unrelated: 0, uncertain: 0.02 } } },
};

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeJson(value));
  return base64url(await crypto.subtle.digest('SHA-256', bytes));
}
function base64url(value: ArrayBuffer | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}
async function bodyHash(value: Uint8Array): Promise<string> {
  return createHash('sha256').update(Buffer.from(value)).digest('base64url');
}
async function makeProof(integrationId: string, eventId: string, eventHash: string, decisionHash: string) {
  resetIdentityStorageForTest();
  const profile = await bootstrapIdentity('Binding owner');
  const input: ApplicationBindingInput = {
    bindingId: '5f1bd4ce-13ca-4d45-a32d-40a2165df521', previousBindingId: null,
    origin: 'https://automation.example.test', integrationId, definitionId: 'application-definition',
    workspaceId: 'workspace-1', cardId: 'card-1', grantId: 'grant-1', eventId, eventHash, decisionHash,
    sourceRecordId: 'source-record-1', sourceHash: 'c'.repeat(43), accessEpoch: 4,
    workflow: { columnId: 'applied', changedAt: '2026-10-14T10:00:00.000Z' },
  };
  const context = await resolveSigningContext({ profile, certificates: [], purpose: 'automation-application-binding',
    authorityRevision: 'authority-1', binding: {
      origin: input.origin, integrationId, definitionId: input.definitionId, workspaceId: input.workspaceId,
      cardId: input.cardId, grantId: input.grantId, eventId, eventHash, decisionHash,
      sourceRecordId: input.sourceRecordId, sourceHash: input.sourceHash, accessEpoch: input.accessEpoch,
    }, current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision: 'authority-1' }) });
  return createApplicationBinding(context, input);
}

describe('application binding private evidence', () => {
beforeEach(() => resetIdentityStorageForTest());

it('Given exact retained MIME and event, when hashing binding evidence, then bind routing, source and captured event', async () => {
  const hash = await bodyHash(rawMimeBytes);
  const result = await applicationBindingEventHash('legacy-worker_1', 'workspace-1',
    { eventId: 'A'.repeat(32), sourceId: mail.message.messageId!, bodyHash: hash }, mail);
  expect(result).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await applicationBindingEventHash('legacy-worker_1', 'workspace-2',
    { eventId: 'A'.repeat(32), sourceId: mail.message.messageId!, bodyHash: hash }, mail)).not.toBe(result);
  const noMessageId = structuredClone(mail);
  noMessageId.message.messageId = null;
  expect(await applicationBindingEventHash('legacy-worker_1', 'workspace-1',
    { eventId: 'A'.repeat(32), sourceId: `sha256:${hash}`, bodyHash: hash }, noMessageId)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(applicationBindingEventHash('legacy-worker_1', 'workspace-1',
    { eventId: 'A'.repeat(32), sourceId: mail.message.messageId!, bodyHash: 'b'.repeat(43) }, mail)).rejects.toThrow();
  await expect(applicationBindingEventHash('legacy-worker_1', 'workspace-1',
    { eventId: 'A'.repeat(32), sourceId: 'wrong-source', bodyHash: hash }, mail)).rejects.toThrow();
  await expect(applicationBindingEventHash('bad/id', 'workspace-1',
    { eventId: 'A'.repeat(32), sourceId: mail.message.messageId!, bodyHash: hash }, mail)).rejects.toThrow();
  await expect(applicationBindingEventHash('worker', '',
    { eventId: 'A'.repeat(32), sourceId: mail.message.messageId!, bodyHash: hash }, mail)).rejects.toThrow();
  await expect(applicationBindingEventHash('worker', 'workspace-1',
    { eventId: 'bad-event', sourceId: mail.message.messageId!, bodyHash: hash }, mail)).rejects.toThrow();
});

it('Given asynchronous hashing, when caller mutates the row and event, then hash uses entry snapshot', async () => {
  const hash = await bodyHash(rawMimeBytes);
  const event = structuredClone(mail);
  const row = { eventId: 'A'.repeat(32), sourceId: event.message.messageId!, bodyHash: hash };
  const expected = await digest({ kind: 'automation-binding-event', version: 1, integrationId: 'worker', workspaceId: 'workspace-1',
    eventId: row.eventId, sourceId: row.sourceId, bodyHash: hash, eventHash: await digest(event) });
  const pending = applicationBindingEventHash('worker', 'workspace-1', row, event);
  row.eventId = 'B'.repeat(32);
  event.message.subject = 'mutated after call';
  expect(await pending).toBe(expected);
});

it('Given a clear retained decision, when hashing it, then preserve the validated decision; uncertain evidence cannot bind', async () => {
  const result = await hashApplicationBindingDecision(classification);
  expect(result.decision).toEqual(classification);
  expect(result.decisionHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(hashApplicationBindingDecision({ ...classification, event: 'uncertain',
    distributions: { application_event: { ...classification.distributions.application_event, choice: 'uncertain', confidence: 1,
      probabilities: { new_opportunity: 0, applied: 0, interview: 0, rejected: 0, offer: 0, follow_up: 0, unrelated: 0, uncertain: 1 } } } })).rejects.toThrow();
});

it('Given a signed event and decision, when encrypting and reopening the private binding, then authenticate scope and retain exact record', async () => {
  const hash = await bodyHash(rawMimeBytes);
  const row = { eventId: 'A'.repeat(32), sourceId: mail.message.messageId!, bodyHash: hash };
  const eventHash = await applicationBindingEventHash('worker', 'workspace-1', row, mail);
  const { decisionHash } = await hashApplicationBindingDecision(classification);
  const proof = await makeProof('worker', row.eventId, eventHash, decisionHash);
  const scope = { integrationId: 'worker', eventId: row.eventId, bindingId: proof.signed.payload.bindingId };
  const record = { proof, decision: classification };
  const encrypted = await encryptApplicationBindingRecord(secret, scope, record);
  expect(encrypted).not.toBe(await encryptApplicationBindingRecord(secret, scope, record));
  expect(await decryptApplicationBindingRecord(secret, scope, encrypted)).toEqual(record);
  for (const altered of [
    { ...scope, integrationId: 'other-worker' }, { ...scope, eventId: 'B'.repeat(32) },
    { ...scope, bindingId: '6f1bd4ce-13ca-4d45-a32d-40a2165df521' },
  ]) await expect(decryptApplicationBindingRecord(secret, altered, encrypted)).rejects.toThrow();
  await expect(decryptApplicationBindingRecord('another sufficiently long secret', scope, encrypted)).rejects.toThrow();
  const cipherStart = encrypted.indexOf('.') + 1;
  const tampered = `${encrypted.slice(0, cipherStart)}${encrypted[cipherStart] === 'A' ? 'B' : 'A'}${encrypted.slice(cipherStart + 1)}`;
  await expect(decryptApplicationBindingRecord(secret, scope, tampered)).rejects.toThrow();
  await expect(encryptApplicationBindingRecord(secret, scope, { proof, decision: { ...classification, event: 'rejection' } })).rejects.toThrow();
  await expect(encryptApplicationBindingRecord('short', scope, record)).rejects.toThrow(/secret/i);
  await expect(encryptApplicationBindingRecord(secret, { ...scope, eventId: 'B'.repeat(32) }, record)).rejects.toThrow(/scope/i);
  const differentDecision: ApplicationEventClassification = { ...classification, event: 'rejection',
    distributions: { application_event: { type: 'choice', choice: 'rejected', confidence: 0.95,
      probabilities: { new_opportunity: 0, applied: 0, interview: 0.01, rejected: 0.95, offer: 0.01, follow_up: 0.01, unrelated: 0, uncertain: 0.02 } } } };
  await expect(encryptApplicationBindingRecord(secret, scope, { proof, decision: differentDecision })).rejects.toThrow(/decision/i);
});
});
