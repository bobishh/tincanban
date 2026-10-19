import { canonicalizeJson, sha256Base64Url } from "../domain/identity"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"

export type ScopeEnrollmentBinding = {
  origin: string; scopeId: string; servicePublicKey: string; personId: string; deviceId: string;
  readTokenHash: string; writeTokenHash: string; revoked: boolean; minimumWriterVersion?: 2;
}
export type ScopeEnrollmentIntent = { version: 1; binding: ScopeEnrollmentBinding; body: string }
const profileKey = "tincanban.local_profile.v1"
const encoder = new TextEncoder()
const maximumBytes = 256 * 1024

function exactFields(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    required.some(field => !Object.hasOwn(value, field)) ||
    Object.keys(value).some(field => !required.includes(field) && !optional.includes(field))) {
    throw new Error("Invalid saved Rusty enrollment intent")
  }
}

function validateBinding(binding: ScopeEnrollmentBinding): void {
  exactFields(binding, ["origin", "scopeId", "servicePublicKey", "personId", "deviceId", "readTokenHash", "writeTokenHash", "revoked"], ["minimumWriterVersion"])
  if (blindOrigin(binding.origin) !== binding.origin ||
    [binding.personId, binding.deviceId, binding.scopeId].some(value => typeof value !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(value)) ||
    [binding.servicePublicKey, binding.readTokenHash, binding.writeTokenHash].some(value => decodeBlindBytes(value).length !== 32) ||
    typeof binding.revoked !== "boolean" || (binding.minimumWriterVersion !== undefined && binding.minimumWriterVersion !== 2)) {
    throw new Error("Invalid saved Rusty enrollment binding")
  }
}

export async function scopeEnrollmentJournalKey(personId: string, origin: string, scopeId: string): Promise<string> {
  const id = await sha256Base64Url(encoder.encode(canonicalizeJson([personId, blindOrigin(origin), scopeId])))
  return `tincanban.rusty-enrollment.v1.${id}`
}

function parse(raw: string, binding: ScopeEnrollmentBinding): ScopeEnrollmentIntent {
  if (encoder.encode(raw).length > maximumBytes) throw new Error("Saved Rusty enrollment exceeds storage bound")
  const value: unknown = JSON.parse(raw)
  exactFields(value, ["version", "binding", "body"])
  const intent = value as ScopeEnrollmentIntent
  validateBinding(intent.binding)
  if (intent.version !== 1 || typeof intent.body !== "string" || !intent.body ||
    canonicalizeJson(intent.binding) !== canonicalizeJson(binding)) {
    throw new Error("A different Rusty enrollment is pending; recover the original request first")
  }
  return intent
}

/** Device-local delivery state. Never exported through private identity preferences. */
export async function readScopeEnrollmentIntent(binding: ScopeEnrollmentBinding): Promise<ScopeEnrollmentIntent | undefined> {
  binding = structuredClone(binding)
  validateBinding(binding)
  const raw = await readLocal(await scopeEnrollmentJournalKey(binding.personId, binding.origin, binding.scopeId))
  return raw === null ? undefined : parse(raw, binding)
}

async function change(binding: ScopeEnrollmentBinding, body: string, remove: boolean,
  ensureCurrent: () => Promise<void>, previousBody?: string): Promise<void> {
  binding = structuredClone(binding)
  validateBinding(binding)
  if (!body || encoder.encode(body).length > maximumBytes / 2) throw new Error("Rusty enrollment request exceeds storage bound")
  const key = await scopeEnrollmentJournalKey(binding.personId, binding.origin, binding.scopeId)
  for (let attempt = 0; attempt < 8; attempt++) {
    await ensureCurrent()
    const [raw, profile] = await Promise.all([readLocal(key), readLocal(profileKey)])
    await ensureCurrent()
    if (profile === null) throw new Error("Identity unavailable during Rusty enrollment persistence")
    const previous = raw === null ? undefined : parse(raw, binding)
    assertPreviousBody(previous, previousBody, body)
    if (remove && !previous) return
    const next = remove ? null : JSON.stringify({ version: 1, binding, body } satisfies ScopeEnrollmentIntent)
    if (next !== null) parse(next, binding)
    const committed = await compareAndSwapLocal({ conditions: [{ key, value: raw }, { key: profileKey, value: profile }],
      writes: [{ key, value: next }] })
    if (committed) { await ensureCurrent(); return }
  }
  throw new Error("Rusty enrollment intent changed repeatedly; retry required")
}

function assertPreviousBody(previous: ScopeEnrollmentIntent | undefined, previousBody: string | undefined, body: string) {
  if (previousBody !== undefined && !previous) throw new Error("Original Rusty enrollment intent is unavailable")
  if (previous && previous.body !== (previousBody ?? body)) throw new Error("A different signed Rusty enrollment request is pending")
}

export function prepareScopeEnrollmentIntent(binding: ScopeEnrollmentBinding, body: string, ensureCurrent: () => Promise<void>): Promise<void> {
  return change(binding, body, false, ensureCurrent)
}

export function completeScopeEnrollmentIntent(binding: ScopeEnrollmentBinding, body: string, ensureCurrent: () => Promise<void>): Promise<void> {
  return change(binding, body, true, ensureCurrent)
}

/** Caller must verify signed server revision and time prove the old request cannot have committed or commit later. */
export function replaceScopeEnrollmentIntent(binding: ScopeEnrollmentBinding, previousBody: string, body: string,
  ensureCurrent: () => Promise<void>): Promise<void> {
  return change(binding, body, false, ensureCurrent, previousBody)
}
