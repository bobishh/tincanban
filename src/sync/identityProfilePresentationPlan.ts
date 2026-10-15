import { z } from "zod"
import type { PublicIdentity } from "../domain/model"
import type { LocalStatePlan } from "../localDb"

const profile = z.object({ identity: z.object({ personId: z.string(), publicKey: z.string(), displayName: z.string() }).strict(),
  device: z.object({ deviceId: z.string(), publicKey: z.string(), displayName: z.string() }).strict(),
  certificate: z.unknown(), privateKeys: z.object({ identityPrivateKeyPkcs8: z.string().optional(), devicePrivateKeyPkcs8: z.string() }).strict(),
}).strict()

/** Presentation-only local write. Serialized keys never become portable profile evidence. */
export function planIdentityProfilePresentation(raw: string | null, identity: PublicIdentity, adoption?: LocalStatePlan): LocalStatePlan {
  const key = "tincanban.local_profile.v1"
  const source = adoption?.writes.find(write => write.key === key)?.value ?? raw
  if (!source) return adoption ?? { conditions: [{ key, value: null }], writes: [] }
  const value = profile.parse(JSON.parse(source))
  if (value.identity.personId !== identity.personId || value.identity.publicKey !== identity.publicKey) throw new Error("Profile identity changed before presentation activation")
  if (value.device.displayName === `${value.identity.displayName}'s device`) value.device.displayName = `${identity.displayName}'s device`
  value.identity.displayName = identity.displayName
  const next = JSON.stringify(value)
  if (!adoption) return { conditions: [{ key, value: raw }], writes: next === raw ? [] : [{ key, value: next }] }
  return { conditions: adoption.conditions, writes: adoption.writes.map(write => write.key === key ? { ...write, value: next } : write) }
}
