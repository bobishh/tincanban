import assert from 'node:assert/strict';
import test from 'node:test';
import { correlateApplication, gmailForwardingConfirmationUrl, parseForwardedMail } from '../src/email.ts';

test('Given a unique exact thread reference, when correlated, then selects the existing application', () => {
  const result = correlateApplication({
    messageId: '<new@example.test>', inReplyTo: '<application@example.test>', references: [],
    from: 'recruiter@example.test', to: 'intake@example.test', subject: 'Interview', text: '', date: null, urls: [], confirmation: false,
  }, [{ cardId: 'card-1', messageIds: ['<application@example.test>'] }]);
  assert.equal(result.kind, 'matched');
});

test('Given two roles at one company and no role clue, when correlated, then requires review', () => {
  const result = correlateApplication({
    messageId: '<mail@example.test>', inReplyTo: null, references: [], from: 'recruiter@example.test',
    to: 'intake@example.test', subject: 'Application update', text: 'Hello Example GmbH', date: null, urls: [], confirmation: false,
  }, [
    { cardId: 'card-1', company: 'Example GmbH', role: 'Engineer' },
    { cardId: 'card-2', company: 'Example GmbH', role: 'Designer' },
  ]);
  assert.equal(result.kind, 'review');
});

test('Given HTML-only forwarded MIME, when parsed, then extracts quoted source URL and thread headers', async () => {
  const raw = [
    'From: user@example.test', 'To: intake@example.test', 'Subject: Fwd: Interview',
    'Message-ID: <forward@example.test>', 'Content-Type: text/html; charset=utf-8', '',
    '<p>Forwarded message</p><p>Subject: Interview</p><p>Message-ID: &lt;original@example.test&gt;</p><p>See https://jobs.example.test/42</p>',
  ].join('\r\n');
  const result = await parseForwardedMail(new TextEncoder().encode(raw));
  assert.equal(result.messageId, '<forward@example.test>');
  assert.equal(result.inReplyTo, null);
  assert.ok(result.text.includes('<original@example.test>'));
  assert.ok(result.urls.includes('https://jobs.example.test/42'));
});

test('Given an original message forwarded as RFC822 attachment, when parsed, then preserves original date, content, job URL and thread reference', async () => {
  const raw = [
    'From: owner@example.test', 'Subject: Fwd: Application received', 'Message-ID: <wrapper@example.test>',
    'Date: Mon, 12 Oct 2026 10:00:00 +0000', 'Content-Type: multipart/mixed; boundary="fwd"', '',
    '--fwd', 'Content-Type: text/plain', '', 'Forwarded copy', '--fwd',
    'Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="original.eml"', '',
    'From: recruiter@example.test', 'Subject: Your application at Example GmbH', 'Message-ID: <original@example.test>',
    'Date: Sun, 11 Oct 2026 09:03:28 +0000', 'Content-Type: text/plain', '',
    'We received your application for Senior Software Engineer. https://jobs.example.test/42', '--fwd--', '',
  ].join('\r\n');
  const mail = await parseForwardedMail(new TextEncoder().encode(raw));
  assert.match(mail.text, /We received your application/);
  assert.ok(mail.urls.includes('https://jobs.example.test/42'));
  assert.ok(mail.references.includes('<original@example.test>'));
  assert.equal(mail.messageId, '<wrapper@example.test>');
  assert.equal(Date.parse(mail.date!), Date.parse('2026-10-11T09:03:28Z'));
});

test('Given a Gmail forwarding verification message, when parsed, then marks it for owner confirmation without treating it as an application', async () => {
  const raw = ['From: forwarding-noreply@google.com', 'Subject: Gmail Forwarding Confirmation - Receive Mail from owner@example.test',
    'Content-Type: text/plain', '', 'owner@example.test has requested to automatically forward mail to your email address.',
    '', 'Confirmation code: 123456789', 'Click the link below to confirm the request:',
    'https://mail.google.com/mail/vf-example-code'].join('\r\n');
  const mail = await parseForwardedMail(new TextEncoder().encode(raw));
  assert.equal(mail.confirmation, true);
});

test('Given Gmail forwarding setup, when choosing its confirmation link, then accepts current and legacy Google hosts and excludes revocation or external links', () => {
  const message = { subject: 'Gmail Forwarding Confirmation - Receive Mail from owner@example.test', text: '' };
  for (const host of ['mail-settings.google.com', 'mail.google.com']) {
    const url = `https://${host}/mail/vf-example-code`;
    assert.equal(gmailForwardingConfirmationUrl({ ...message, urls: [url] }), url);
  }
  for (const url of ['https://mail-settings.google.com/mail/uf-revoke', 'http://mail.google.com/mail/vf-code', 'https://mail.google.com.evil.test/mail/vf-code']) {
    assert.equal(gmailForwardingConfirmationUrl({ ...message, urls: [url] }), null);
  }
});

test('Given a job email with wrapped company and role names, when correlated, then whitespace does not hide a unique application', () => {
  const result = correlateApplication({ messageId: '<wrapped@example.test>', inReplyTo: null, references: [],
    subject: 'Caspar Health update', text: 'We received your application for Senior Backend & AI Engineer\r\n(all identities).', urls: [] },
  [{ cardId: 'caspar', company: 'Caspar Health', role: 'Senior Backend & AI Engineer (all identities)' },
    { cardId: 'other-role', company: 'Caspar Health', role: 'Product Designer' }]);
  assert.deepEqual(result, { kind: 'matched', cardId: 'caspar', method: 'company-role' });
});
