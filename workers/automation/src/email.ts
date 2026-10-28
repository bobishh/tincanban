import { emailJobIdentity } from "./emailVacancy.ts";

export const MAX_RAW_EMAIL_BYTES = 1_048_576;
const MAX_TEXT_BYTES = 64_000;
const MAX_URLS = 50;
const MAX_ATTACHMENTS = 10;

export interface ForwardedMail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string;
  to: string;
  subject: string;
  text: string;
  date: string | null;
  urls: string[];
  confirmation: boolean;
  attachments: Array<{ filename: string | null; contentType: string; size: number }>;
}

export interface ApplicationCandidate {
  cardId: string;
  jobUrl?: string;
  messageIds?: string[];
  company?: string;
  role?: string;
  sources?: import("../../../src/domain/applicationSourceData").ApplicationSourceData[];
}

export type CorrelationResult =
  | { kind: 'matched'; cardId: string; method: 'thread' | 'job-url' | 'ats-id' | 'company-role' }
  | { kind: 'review'; reason: string; candidates: string[] };

/** Read explicit receipt labels; absent or conflicting identities remain reviewable. */
export function emailApplicationIdentity(mail: Pick<ForwardedMail, 'subject' | 'text'>): { company: string; role: string } | null {
  const companies = new Map<string, string>();
  const roles = new Map<string, string>();
  const add = (values: Map<string, string>, value: string) => {
    const label = value.replace(/\s+/g, ' ').trim().replace(/^["“”']+|["“”']+$/g, '');
    if (label.length >= 2 && label.length <= 200) values.set(normalizePhrase(label), label);
  };
  const subject = mail.subject.replace(/^(?:(?:fwd?|wg|re):\s*)+/i, '').trim();
  const text = mail.text.replace(/\r\n?/g, '\n');
  for (const match of subject.matchAll(/(?:your application|applying) (?:to|at|with) ([^,!\n]+?)(?:[,!]|$)/gi)) add(companies, match[1]);
  for (const match of text.matchAll(/interest in (?:joining|working (?:at|for))\s+([^!.\n]+)[!.\n]/gi)) add(companies, match[1]);
  for (const match of text.matchAll(/^(?:company|unternehmen):\s*([^\n]+)$/gim)) add(companies, match[1]);
  for (const match of text.matchAll(/^(?:role|position|stelle):\s*([^\n]+)$/gim)) add(roles, match[1]);
  const context = `${subject}\n${text}`;
  for (const match of context.matchAll(/Bewerbung als\s+([^!\n]+?)\s+bei\s+([^!\n]+?)(?:[!\n]|$)/gi)) {
    add(roles, match[1]); add(companies, match[2]);
  }
  for (const match of context.matchAll(/(?:application|applying) for (?:the )?([^!\n]+?) (?:position )?(?:at|with) ([^,!\n.]+)(?:[,.!]|$)/gi)) {
    add(roles, match[1]); add(companies, match[2]);
  }
  const folded = text.replace(/\s+/g, ' ');
  for (const match of folded.matchAll(/(?:application (?:to|for)|applying for) (?:the )?(.{2,200}?) (?:position|role|vacancy)\b/gi)) add(roles, match[1]);
  if (companies.size !== 1 || roles.size !== 1) return null;
  return { company: [...companies.values()][0], role: [...roles.values()][0] };
}

export function emailNoteText(mail: Pick<ForwardedMail, 'subject' | 'from' | 'date' | 'text'>): string {
  const subject = mail.subject.replace(/^(?:(?:fwd?|wg):\s*)+/i, '').trim();
  return `### Email: ${subject}\n\nFrom: ${mail.from}\nDate: ${mail.date ?? 'Unknown'}\n\n${mail.text.trim()}`;
}

export async function parseForwardedMail(input: ArrayBuffer | Uint8Array, nested = false): Promise<ForwardedMail> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > MAX_RAW_EMAIL_BYTES) throw new TypeError('Email exceeds the raw message size limit');
  const { default: PostalMime } = await import('postal-mime');
  const message = await new PostalMime({ maxNestingDepth: 30, maxHeadersSize: 64_000, maxPartCount: 100, maxRfc822NestingDepth: 0, forceRfc822Attachments: true }).parse(bytes);
  const headers = new Map<string, string>();
  for (const header of message.headers ?? []) {
    if (typeof header.key === 'string' && typeof header.value === 'string') headers.set(header.key.toLowerCase(), header.value);
  }
  const parsedText = typeof message.text === 'string' ? message.text : '';
  const htmlText = typeof message.html === 'string' ? htmlToText(message.html) : '';
  const text = boundText(parsedText.trim() ? parsedText : htmlText);
  const forwardedHeaders = readForwardedHeaders(text);
  const subject = (message.subject || forwardedHeaders.subject || '').slice(0, 500).trim();
  const references = uniqueTokens([
    ...messageIds(headers.get('references')),
    ...messageIds(message.references),
  ]).slice(0, 40);
  const messageId = oneMessageId(headers.get('message-id') ?? message.messageId);
  const inReplyTo = oneMessageId(headers.get('in-reply-to') ?? message.inReplyTo);
  const attachments = (message.attachments ?? []).map((attachment) => ({
    filename: typeof attachment.filename === 'string' ? attachment.filename.slice(0, 256) : null,
    contentType: typeof attachment.mimeType === 'string' ? attachment.mimeType.slice(0, 128) : 'application/octet-stream',
    size: contentSize(attachment.content),
  }));
  if (attachments.length > MAX_ATTACHMENTS || attachments.some((attachment) => attachment.size > MAX_RAW_EMAIL_BYTES)) {
    throw new TypeError('Email has too many or oversized attachments');
  }
  const attachmentBytes = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (attachmentBytes > MAX_RAW_EMAIL_BYTES) throw new TypeError('Email attachments exceed the size limit');
  const originals = (message.attachments ?? []).filter(attachment => attachment.mimeType === 'message/rfc822');
  if (originals.length > 1 || nested && originals.length) throw new TypeError('Only one original forwarded message is supported');
  if (originals.length === 1) {
    const content = originals[0].content;
    const originalBytes = typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
    const original = await parseForwardedMail(originalBytes, true);
    return { ...original, messageId,
      references: uniqueTokens([...references, ...original.references, ...(original.messageId ? [original.messageId] : [])]).slice(0, 40) };
  }
  const dateValue = message.date ?? headers.get('date') ?? null;
  const urls = uniqueTokens([...extractUrls(text), ...extractUrls(typeof message.html === 'string' ? message.html : '')]).slice(0, MAX_URLS);
  return {
    messageId,
    inReplyTo,
    references,
    from: formatAddress(message.from).slice(0, 500),
    to: formatAddress(message.to).slice(0, 500),
    subject,
    text,
    date: typeof dateValue === 'string' ? dateValue.slice(0, 128) : null,
    urls,
    confirmation: isForwardingConfirmation(subject, text),
    attachments,
  };
}

export function correlateApplication(mail: Pick<ForwardedMail, 'messageId' | 'inReplyTo' | 'references' | 'subject' | 'text' | 'urls'>, candidates: ApplicationCandidate[]): CorrelationResult {
  const incomingIds = new Set(uniqueTokens([mail.messageId, mail.inReplyTo, ...mail.references].filter((value): value is string => !!value).map(normalizeMessageId)));
  const threadMatches = candidates.filter((candidate) => (candidate.messageIds ?? []).some((id) => incomingIds.has(normalizeMessageId(id))));
  if (threadMatches.length === 1) return { kind: 'matched', cardId: threadMatches[0].cardId, method: 'thread' };
  if (threadMatches.length > 1) return review('Message thread references multiple applications', threadMatches);

  const incomingUrls = new Set(mail.urls.map(normalizeJobUrl).filter(Boolean));
  const urlMatches = candidates.filter((candidate) => candidate.jobUrl && incomingUrls.has(normalizeJobUrl(candidate.jobUrl)));
  if (urlMatches.length === 1) return { kind: 'matched', cardId: urlMatches[0].cardId, method: 'job-url' };
  if (urlMatches.length > 1) return review('Job URL matches multiple applications', urlMatches);

  const context = normalizePhrase(`${mail.subject}\n${mail.text}`);
  const contextMatches = candidates.filter((candidate) => {
    const company = normalizePhrase(candidate.company);
    const role = normalizePhrase(candidate.role);
    return company.length >= 3 && role.length >= 3 && context.includes(company) && context.includes(role);
  });
  if (contextMatches.length === 1) return { kind: 'matched', cardId: contextMatches[0].cardId, method: 'company-role' };
  if (contextMatches.length > 1) return review('Company and role context matches multiple applications', contextMatches);
  const sameCompany = candidates.filter((candidate) => {
    const company = normalizePhrase(candidate.company);
    return company.length >= 3 && context.includes(company);
  });
  return review(sameCompany.length ? 'Company context does not identify a role' : 'No existing application matched', sameCompany.length ? sameCompany : candidates);
}

function review(reason: string, candidates: ApplicationCandidate[]): CorrelationResult {
  return { kind: 'review', reason, candidates: [...new Set(candidates.map((candidate) => candidate.cardId))] };
}

function messageIds(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value.match(/<[^<>\s]{1,480}>/g) ?? [];
}

function oneMessageId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/<[^<>\s]{1,480}>/);
  return match?.[0] ?? (value.trim().length <= 500 ? value.trim() || null : null);
}

function normalizeMessageId(value: string): string {
  return value.trim().replace(/^<|>$/g, '').toLowerCase();
}

function normalizeJobUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|gclid|fbclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase();
    return emailJobIdentity(url.toString()).replace(/\/$/, '');
  } catch {
    return '';
  }
}

function normalizePhrase(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s<>"']+/gi)?.map((value) => value.replace(/[),.;!?\]}]+$/g, '')) ?? [];
}

function htmlToText(html: string): string {
  return html.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/(?:p|div|br|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith('#x')) return decodeCodePoint(match, Number.parseInt(lower.slice(2), 16));
      if (lower.startsWith('#')) return decodeCodePoint(match, Number.parseInt(lower.slice(1), 10));
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[lower] ?? match;
    })
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

function decodeCodePoint(fallback: string, value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : fallback;
}

function boundText(value: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= MAX_TEXT_BYTES) return value;
  let result = value.slice(0, MAX_TEXT_BYTES);
  while (encoder.encode(result).byteLength > MAX_TEXT_BYTES) result = result.slice(0, -256);
  return result;
}

function formatAddress(value: unknown): string {
  if (!value) return '';
  const addresses = Array.isArray(value) ? value : [value];
  return addresses.map((address) => {
    if (typeof address === 'string') return address;
    if (!address || typeof address !== 'object') return '';
    const entry = address as { name?: unknown; address?: unknown };
    const email = typeof entry.address === 'string' ? entry.address : '';
    const name = typeof entry.name === 'string' ? entry.name : '';
    return name && email ? `${name} <${email}>` : email || name;
  }).filter(Boolean).join(', ');
}

function contentSize(value: unknown): number {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value.byteLength;
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  return 0;
}

function uniqueTokens(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readForwardedHeaders(text: string): { subject?: string } {
  const lines = text.slice(0, 12_000).split(/\r?\n/);
  const fields: Record<string, string> = {};
  let current: string | undefined;
  for (const line of lines) {
    const match = line.match(/^\s*subject\s*:\s*(.*)$/i);
    if (match) {
      current = 'subject';
      fields.subject = match[1].trim();
    } else if (/^\s/.test(line) && current === 'subject') {
      fields.subject = `${fields.subject} ${line.trim()}`.trim();
    } else if (!line.trim()) {
      if (Object.keys(fields).length) break;
      current = undefined;
    } else if (Object.keys(fields).length) break;
  }
  return { subject: fields.subject };
}

export function isForwardingConfirmation(subject: string, text: string): boolean {
  if (/\b(?:gmail\s+)?forwarding\s+(?:confirmation|verification)\b/i.test(subject)) return true;
  return /(?:confirm|verify).{0,80}(?:forward(?:ing)? address|email address|mail routing)|(?:forward(?:ing)? address|email address).{0,80}(?:confirm|verify)/i.test(`${subject}\n${text.slice(0, 2_000)}`);
}

export function gmailForwardingConfirmationUrl(mail: Pick<ForwardedMail, 'subject' | 'text' | 'urls'>): string | null {
  if (!isForwardingConfirmation(mail.subject, mail.text)) return null;
  return mail.urls.find(value => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'https:' && ['mail.google.com', 'mail-settings.google.com'].includes(parsed.hostname)
        && parsed.pathname.startsWith('/mail/vf-');
    }
    catch { return false; }
  }) ?? null;
}
