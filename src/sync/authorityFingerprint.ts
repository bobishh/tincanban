import type { IncomingAuthorizationBundle, WorkspaceWriteAuthorityEvidence } from "../product-replica"
import type { WorkspaceAuthorityRecord, WorkspaceMeshCredential } from "./peerStore"

/**
 * Stable projection of persisted authorization state. Peer presence and record timestamps
 * and empty optional collections do not affect policy; effective security values remain visible.
 */
export function workspaceAuthorityFingerprint(
  credentials: WorkspaceMeshCredential[],
  authorities: WorkspaceAuthorityRecord[],
): string {
  const credentialState = credentials.map(credential => {
    const security: Record<string, unknown> = { ...credential }
    delete security.transportSecret
    delete security.updatedAt
    return normalizeAuthorityDefaults(security)
  })
  const authorityState = authorities.map(authority => {
    const security: Record<string, unknown> = { ...authority }
    delete security.updatedAt
    return normalizeAuthorityDefaults(security)
  })
  return canonicalJson({
    credentials: canonicalSort(credentialState),
    authorities: canonicalSort(authorityState),
  })
}

/** Empty optional collections carry no grants, revocations, or prior owners. */
function normalizeAuthorityDefaults(security: Record<string, unknown>) {
  if (Array.isArray(security.ownerHistory) && security.ownerHistory.length === 0) delete security.ownerHistory
  if (security.catalog && typeof security.catalog === "object" && !Array.isArray(security.catalog)) {
    const catalog = { ...security.catalog } as Record<string, unknown>
    for (const key of ["departures", "deviceRevocations", "revocations", "ownershipTransfers", "successionVotes", "successionClaims"]) {
      if (Array.isArray(catalog[key]) && catalog[key].length === 0) delete catalog[key]
    }
    security.catalog = normalizeCertificateSets(catalog)
    if (Object.keys(security.catalog as object).length === 0) delete security.catalog
  }
  return normalizeCertificateSets(security)
}

export class AuthorityFingerprintTracker {
  private current?: string

  update(next: string): boolean {
    if (this.current === next) return false
    this.current = next
    return true
  }
}

function canonicalSort(values: unknown[]): unknown[] {
  return values.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
}

/** Omit unsigned undefined fields; certificate sets sort, while signed payloads retain their exact structure. */
export function normalizeCertificateSets<T>(value: T): T {
  if (Array.isArray(value)) return (value as unknown[]).map(item => normalizeCertificateSets(item)) as T
  if (!value || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  if ("signature" in record && "payload" in record) return value
  return Object.fromEntries(Object.entries(record).filter(([, item]) => item !== undefined).map(([key, item]) => [key,
    Array.isArray(item) && (key === "certificates" || key === "ownerCertificates")
      ? canonicalSort((item as unknown[]).slice()) : normalizeCertificateSets(item)])) as T
}

export function canonicalAuthorityJson(value: unknown): string {
  return canonicalJson(normalizeCertificateSets(value))
}

/** Absent departures are an empty set. A non-array is rejected rather than treated as none. */
export function normalizeAuthorityDepartures(authority: WorkspaceWriteAuthorityEvidence): WorkspaceWriteAuthorityEvidence {
  const departures = (authority as { departures?: unknown }).departures
  if (departures === undefined) return { ...authority, departures: [] }
  if (!Array.isArray(departures)) throw new Error("Invalid workspace authority departures")
  return authority
}

/** Packet authority uses admission normalization. A mismatch or malformed packet is not a reuse. */
export function packetMatchingVerifiedAuthority(authorization: unknown, verified: WorkspaceWriteAuthorityEvidence): unknown[] | undefined {
  try {
    const bundle = authorization as IncomingAuthorizationBundle
    if (!bundle || ![1, 2].includes(bundle.version) || !bundle.authority ||
      (bundle.version === 1 ? !Array.isArray(bundle.records) : !Array.isArray(bundle.pages))) return
    const packet = normalizeCertificateSets(normalizeAuthorityDepartures(bundle.authority))
    if (canonicalAuthorityJson(packet) !== canonicalAuthorityJson(verified)) return
    return bundle.version === 1 ? bundle.records : bundle.pages.flat()
  } catch { return }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}
