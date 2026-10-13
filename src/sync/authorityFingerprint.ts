import type { WorkspaceAuthorityRecord, WorkspaceMeshCredential } from "./peerStore"

/**
 * Stable projection of persisted authorization state. Peer presence and record timestamps
 * do not affect policy, while every credential/authority field can affect admission.
 */
export function workspaceAuthorityFingerprint(
  credentials: WorkspaceMeshCredential[],
  authorities: WorkspaceAuthorityRecord[],
): string {
  const credentialState = credentials.map(credential => {
    const security: Record<string, unknown> = { ...credential }
    delete security.transportSecret
    delete security.updatedAt
    return normalizeCertificateSets(security)
  })
  const authorityState = authorities.map(authority => {
    const security: Record<string, unknown> = { ...authority }
    delete security.updatedAt
    return normalizeCertificateSets(security)
  })
  return canonicalJson({
    credentials: canonicalSort(credentialState),
    authorities: canonicalSort(authorityState),
  })
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

/** Certificate collections are sets; signed payloads and all other arrays retain their order. */
export function normalizeCertificateSets<T>(value: T): T {
  if (Array.isArray(value)) return (value as unknown[]).map(item => normalizeCertificateSets(item)) as T
  if (!value || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  if ("signature" in record && "payload" in record) return value
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key,
    Array.isArray(item) && (key === "certificates" || key === "ownerCertificates")
      ? canonicalSort((item as unknown[]).slice()) : normalizeCertificateSets(item)])) as T
}

export function canonicalAuthorityJson(value: unknown): string {
  return canonicalJson(normalizeCertificateSets(value))
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}
