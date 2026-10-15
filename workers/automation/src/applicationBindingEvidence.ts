import { canonicalizeJson } from '../../../src/domain/identity.ts';
import { parseApplicationBindingProof, type ApplicationBindingProof } from '../../../src/domain/applicationBinding.ts';
import { readApplicationEventClassification, type ApplicationEventClassification } from './clef.ts';
import type { AutomationEvent } from './pipeline.ts';

const MAX_ENCRYPTED_BYTES = 384 * 1024;
const MAX_RAW_MIME_BYTES = 1_048_576;
const eventIdPattern = /^[A-Za-z0-9_-]{20,64}$/;
const hashPattern = /^[A-Za-z0-9_-]{43}$/;
const integrationPattern = /^[A-Za-z0-9_-]{1,128}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

type EmailEvent = Extract<AutomationEvent, { source: 'email' }>;
export type ApplicationBindingScope = { integrationId: string; eventId: string; bindingId: string };
export type ApplicationBindingRecord = { proof: ApplicationBindingProof; decision: ApplicationEventClassification };

/** Hash exact event evidence and its immutable intake row under routing-specific domain separation. */
export async function applicationBindingEventHash(integrationId: string, workspaceId: string,
  rowValue: { eventId: string; sourceId: string; bodyHash: string }, eventValue: EmailEvent): Promise<string> {
  const row = structuredClone(rowValue);
  const event = structuredClone(eventValue);
  const rawMimeBytes = validateEventInputs(integrationId, workspaceId, row, event);
  if (row.bodyHash !== encodeBase64Url(await sha256(rawMimeBytes))) {
    throw new Error('Application binding MIME digest does not match event row');
  }
  const eventHash = encodeBase64Url(await sha256(encoder.encode(canonicalizeJson(event))));
  return encodeBase64Url(await sha256(encoder.encode(canonicalizeJson({ kind: 'automation-binding-event', version: 1,
    integrationId, workspaceId, eventId: row.eventId, sourceId: row.sourceId, bodyHash: row.bodyHash, eventHash }))));
}

/** Validate and hash clear retained classifier evidence. Uncertain decisions cannot authorize a binding. */
export async function hashApplicationBindingDecision(value: unknown): Promise<{ decision: ApplicationEventClassification; decisionHash: string }> {
  const decision = readApplicationEventClassification(structuredClone(value));
  if (decision.event === 'uncertain') throw new Error('Uncertain application decisions cannot be bound');
  const decisionHash = encodeBase64Url(await sha256(encoder.encode(canonicalizeJson(decision))));
  return { decision, decisionHash };
}

/** Encrypt an immutable signed proof and its validated decision with scope-specific AES-GCM AAD. */
export async function encryptApplicationBindingRecord(secret: string, scopeValue: ApplicationBindingScope,
  recordValue: ApplicationBindingRecord): Promise<string> {
  const scope = validateScope(structuredClone(scopeValue));
  const record = await captureRecord(recordValue, scope);
  const plaintext = encoder.encode(canonicalizeJson(record));
  if (plaintext.byteLength > MAX_ENCRYPTED_BYTES) throw new TypeError('Application binding record exceeds the size limit');
  const key = await importStorageKey(secret);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: encoder.encode(aad(scope)), tagLength: 128 }, key, plaintext));
  const encoded = `${encodeBase64Url(nonce)}.${encodeBase64Url(ciphertext)}`;
  if (encoded.length > MAX_ENCRYPTED_BYTES) throw new TypeError('Encrypted application binding record exceeds the size limit');
  return encoded;
}

/** Decrypt and validate the exact private proof/decision under the caller-supplied scope. */
export async function decryptApplicationBindingRecord(secret: string, scopeValue: ApplicationBindingScope,
  encryptedValue: string): Promise<ApplicationBindingRecord> {
  const scope = validateScope(structuredClone(scopeValue));
  if (typeof encryptedValue !== 'string' || encryptedValue.length < 20 || encryptedValue.length > MAX_ENCRYPTED_BYTES) {
    throw new TypeError('Encrypted application binding record has an invalid size');
  }
  const [nonceValue, ciphertextValue, extra] = encryptedValue.split('.');
  if (!nonceValue || !ciphertextValue || extra !== undefined) throw new TypeError('Encrypted application binding record has invalid encoding');
  const nonce = decodeBase64Url(nonceValue);
  const ciphertext = decodeBase64Url(ciphertextValue);
  if (nonce.byteLength !== 12 || ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_ENCRYPTED_BYTES) {
    throw new TypeError('Encrypted application binding record has invalid ciphertext');
  }
  const key = await importStorageKey(secret);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce,
    additionalData: encoder.encode(aad(scope)), tagLength: 128 }, key, ciphertext));
  if (plaintext.byteLength > MAX_ENCRYPTED_BYTES) throw new TypeError('Decrypted application binding record exceeds the size limit');
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(plaintext)) as unknown; }
  catch { throw new TypeError('Decrypted application binding record is not valid UTF-8 JSON'); }
  return captureRecord(parsed, scope);
}

async function captureRecord(value: unknown, scope: ApplicationBindingScope): Promise<ApplicationBindingRecord> {
  const snapshot = structuredClone(value);
  if (!isRecord(snapshot) || !exactKeys(snapshot, ['proof', 'decision'])) throw new TypeError('Application binding record has an invalid shape');
  const proof = parseApplicationBindingProof(snapshot.proof);
  const { decision, decisionHash } = await hashApplicationBindingDecision(snapshot.decision);
  const payload = proof.signed.payload;
  if (payload.integrationId !== scope.integrationId || payload.eventId !== scope.eventId || payload.bindingId !== scope.bindingId) {
    throw new Error('Application binding proof does not match encrypted record scope');
  }
  if (payload.decisionHash !== decisionHash) throw new Error('Application binding proof does not match retained decision');
  return { proof, decision };
}

function validateEventInputs(integrationId: string, workspaceId: string,
  row: { eventId: string; sourceId: string; bodyHash: string }, event: EmailEvent): Uint8Array {
  if (typeof integrationId !== 'string' || !integrationPattern.test(integrationId)) throw new TypeError('Invalid application binding integration ID');
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 256) throw new TypeError('Invalid application binding workspace ID');
  if (!row || typeof row !== 'object' || !eventIdPattern.test(row.eventId) || !hashPattern.test(row.bodyHash)) {
    throw new TypeError('Invalid application binding event row');
  }
  if (!event || event.source !== 'email' || typeof event.rawMime !== 'string') throw new TypeError('Application binding requires retained email event');
  const rawMimeBytes = decodeBase64Url(event.rawMime);
  if (rawMimeBytes.byteLength > MAX_RAW_MIME_BYTES) throw new TypeError('Retained MIME exceeds the size limit');
  const expectedSourceId = event.message.messageId ?? `sha256:${row.bodyHash}`;
  if (row.sourceId !== expectedSourceId) throw new Error('Application binding source ID does not match retained email');
  return rawMimeBytes;
}

function validateScope(scope: ApplicationBindingScope): ApplicationBindingScope {
  if (!isRecord(scope) || !exactKeys(scope, ['integrationId', 'eventId', 'bindingId']) ||
    typeof scope.integrationId !== 'string' || !integrationPattern.test(scope.integrationId) ||
    typeof scope.eventId !== 'string' || !eventIdPattern.test(scope.eventId) ||
    typeof scope.bindingId !== 'string' || !uuidPattern.test(scope.bindingId)) {
    throw new TypeError('Invalid application binding encryption scope');
  }
  return scope;
}

function aad(scope: ApplicationBindingScope): string {
  return canonicalizeJson(['TIN/application-binding/v1', scope.integrationId, scope.eventId, scope.bindingId]);
}

async function importStorageKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== 'string' || encoder.encode(secret).byteLength < 32) throw new TypeError('Application binding storage secret is too short');
  const keyBytes = await sha256(encoder.encode(`TIN/application-binding-key/v1/${secret}`));
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', value));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError('Invalid base64url ciphertext');
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  let binary: string;
  try { binary = atob(base64); } catch { throw new TypeError('Invalid base64url ciphertext'); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== value) throw new TypeError('Non-canonical base64url ciphertext');
  return bytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
