export const identityStateRevisionKey = "tincanban.identity-state-revision.v1"
type Revision = { version: 1; generation: string; revision: number }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .filter(([, item]) => item !== undefined).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}

export function tracksIdentityContent(key: string): boolean {
  return ["tincanban.v1.personal_roots", "tincanban.local_profile.v1", "tincanban.v1.proof_store", "tincanban.identity_recovery.v1"].includes(key) ||
    ["tincanban.private-replica-state.v2.", "tincanban.rusty-management.v1.", "tincanban.identity-recovery-evidence.v1.",
      "tincanban.identity-device-extensions.v1.",
      "tincanban.identity-profile-projections.v1."].some(prefix => key.startsWith(prefix))
}

/** Select portable content only. Device progress, pending delivery and historical board proofs do not invalidate it. */
function selectedContent(key: string, raw: string | null): unknown {
  if (raw === null) return null
  let value: Record<string, unknown>
  try { value = JSON.parse(raw) as Record<string, unknown> }
  catch { return raw }
  if (!value || typeof value !== "object") return value
  if (key === "tincanban.v1.proof_store") return value.certificates
  if (key === "tincanban.local_profile.v1") return { identity: value.identity, device: value.device, certificate: value.certificate }
  if (key.startsWith("tincanban.private-replica-state.v2.")) return {
    version: value.version, personId: value.personId, entries: value.entries, clock: value.clock,
  }
  if (key.startsWith("tincanban.rusty-management.v1.") && Array.isArray(value.records)) {
    return (value.records as { binding?: unknown; capability?: unknown }[]).filter(record => record.capability)
      .map(record => ({ binding: record.binding, capability: record.capability }))
  }
  return value
}

export function identityContentChanged(key: string, before: string | null, after: string | null): boolean {
  return tracksIdentityContent(key) && before !== after && canonical(selectedContent(key, before)) !== canonical(selectedContent(key, after))
}

export function parseIdentityRevision(raw: string | null): Revision {
  if (raw === null) return { version: 1, generation: crypto.randomUUID(), revision: 0 }
  const value = JSON.parse(raw) as Revision
  if (!value || value.version !== 1 || typeof value.generation !== "string" || !/^[0-9a-f-]{36}$/i.test(value.generation) ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 || Object.keys(value).some(key => !["version", "generation", "revision"].includes(key))) {
    throw new Error("Invalid identity content revision")
  }
  return value
}

export function advanceIdentityRevision(raw: string | null): string {
  const revision = parseIdentityRevision(raw)
  if (revision.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Identity content revision exhausted")
  return JSON.stringify({ ...revision, revision: revision.revision + 1 })
}
