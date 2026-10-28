import {
  mergeIdentityAuthorityViews,
  verifyIdentityAuthorityView,
  type IdentityAuthorityView,
  type VerifiedIdentityAuthorityView,
} from "@meta-uber/mesh-identity"
import { mergeRustyIdentityEnforcement, type RustyIdentityEnforcement } from "@meta-uber/mesh-replication/rusty-identity-authority"
import { compareAndSwapLocal, readLocal } from "../localDb"
import { identityAuthorityViewKey as domainIdentityAuthorityViewKey, readLearnedIdentityAuthorityView } from "../domain/identityAuthority"

const keyFor = domainIdentityAuthorityViewKey
const enforcementKeyFor = (origin: string, serviceId: string) =>
  `tincanban.rusty-identity-enforcement.v1.${encodeURIComponent(origin)}.${serviceId}`

export function identityAuthorityViewKey(personId: string): string { return keyFor(personId) }

export async function mergeRustyIdentityServiceEnforcement(origin: string, serviceId: string,
  incoming: RustyIdentityEnforcement): Promise<RustyIdentityEnforcement> {
  const key = enforcementKeyFor(origin, serviceId)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const previousRaw = await readLocal(key)
    let previous: RustyIdentityEnforcement | null = null
    if (previousRaw !== null) {
      let value: unknown
      try { value = JSON.parse(previousRaw) as unknown }
      catch { throw new Error("Stored Rusty Identity enforcement state is malformed") }
      if (!isEnforcementRecord(value) || value.origin !== origin || value.serviceId !== serviceId) {
        throw new Error("Stored Rusty Identity enforcement state does not match its service")
      }
      previous = value.enforcement
    }
    const enforcement = mergeRustyIdentityEnforcement(previous, incoming)
    if (previousRaw === JSON.stringify({ version: 1, origin, serviceId, enforcement })) return enforcement
    if (await compareAndSwapLocal({ conditions: [{ key, value: previousRaw }], writes: [{ key,
      value: JSON.stringify({ version: 1, origin, serviceId, enforcement }) }] })) return enforcement
  }
  throw new Error("Rusty Identity enforcement changed repeatedly; retry required")
}

function isEnforcementRecord(value: unknown): value is { version: 1; origin: string; serviceId: string; enforcement: RustyIdentityEnforcement } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 4 || record.version !== 1 || typeof record.origin !== "string" ||
      typeof record.serviceId !== "string" || !record.enforcement || typeof record.enforcement !== "object") return false
  const enforcement = record.enforcement as Partial<RustyIdentityEnforcement>
  return (enforcement.mode === "additive" && enforcement.epoch === 0) ||
    (enforcement.mode === "strict" && enforcement.epoch === 1)
}

/** Load the one durable, cryptographically verified authority view for a person. */
export async function readIdentityAuthorityView(personId: string): Promise<VerifiedIdentityAuthorityView | null> {
  return readLearnedIdentityAuthorityView(personId)
}

export async function requireIdentityAuthorityView(personId: string): Promise<VerifiedIdentityAuthorityView> {
  const view = await readIdentityAuthorityView(personId)
  if (!view) throw new Error("Current Identity authority view is required before private Rusty access")
  return view
}

/** Persist a verified union with compare-and-swap; retained older history cannot lower the accepted revocation head. */
export async function mergeIdentityAuthorityView(
  incomingValue: IdentityAuthorityView,
  ensureCurrent: () => void = () => {},
): Promise<VerifiedIdentityAuthorityView> {
  const incoming = await verifyIdentityAuthorityView(incomingValue)
  const key = keyFor(incoming.personId)
  for (let attempt = 0; attempt < 8; attempt += 1) {
    ensureCurrent()
    const previousRaw = await readLocal(key)
    let merged = incoming
    if (previousRaw !== null) {
      let previous: unknown
      try { previous = JSON.parse(previousRaw) as unknown }
      catch { throw new Error("Stored Identity authority view is malformed") }
      merged = await reconcileIdentityAuthorityHistory(previous, incoming)
    }
    ensureCurrent()
    const next = JSON.stringify(merged)
    if (await compareAndSwapLocal({ conditions: [{ key, value: previousRaw }], writes: [{ key, value: next }] }, ensureCurrent)) {
      return await verifyIdentityAuthorityView(merged)
    }
  }
  throw new Error("Identity authority view changed repeatedly; retry required")
}

/** Prepare a monotonic authority merge for the same transaction that activates a device transfer. */
export async function planIdentityAuthorityViewMerge(personId: string, incomingValue: IdentityAuthorityView) {
  const incoming = await verifyIdentityAuthorityView(incomingValue)
  if (incoming.personId !== personId) throw new Error("Identity authority view belongs to another person")
  const key = keyFor(personId)
  const previousRaw = await readLocal(key)
  let merged = incoming
  if (previousRaw !== null) {
    let previous: unknown
    try { previous = JSON.parse(previousRaw) as unknown }
    catch { throw new Error("Stored Identity authority view is malformed") }
    merged = await reconcileIdentityAuthorityHistory(previous, incoming)
  }
  const next = JSON.stringify(merged)
  return {
    conditions: [{ key, value: previousRaw }],
    writes: next === previousRaw ? [] : [{ key, value: next }],
    authorityView: merged,
  }
}

/** The SDK validates the shorter history as a prefix of the longer one, including certificate conflicts. */
export async function reconcileIdentityAuthorityHistory(previous: unknown, incomingValue: IdentityAuthorityView): Promise<VerifiedIdentityAuthorityView> {
  const current = await verifyIdentityAuthorityView(previous)
  const incoming = await verifyIdentityAuthorityView(incomingValue)
  return current.revocationHead.revision > incoming.revocationHead.revision
    ? mergeIdentityAuthorityViews(incoming, current)
    : mergeIdentityAuthorityViews(current, incoming)
}
