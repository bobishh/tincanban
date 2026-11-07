import type { StoredChatProfile } from "./store"

/** Records and profiles here have already passed chat signature and workspace-grant admission. */
export function messageAuthor(message: { personId: string; record?: unknown },
  profiles: Pick<StoredChatProfile, "name" | "record">[], fallback: string): string {
  const record = message.record as { authority?: { publicKey?: string; grant?: { payload?: { role?: string; personId?: string } } } } | undefined
  const authority = record?.authority, grant = authority?.grant?.payload
  if (grant?.role !== "automation" || grant.personId !== message.personId) return fallback
  const owner = profiles.find(profile => {
    const proof = profile.record as { publicKey?: string } | undefined
    return proof?.publicKey && proof.publicKey === authority?.publicKey
  })
  return owner ? `${owner.name} (Automation)` : "Automation"
}
