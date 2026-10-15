import { z } from "zod"
import type { PublicIdentity } from "../domain/model"
import type { ChatRecord } from "../chat/records"
import { verifyPrivateProfileObservation } from "../chat/privateProfileObservation"
import { canonicalizeJson } from "../domain/identity"
import { compareAndSwapLocal, readLocal, type LocalStatePlan } from "../localDb"
import { IdentityDeviceStateUpgradeRequiredError } from "./identityDeviceStateCodec"
import { identityProfileProjectionKey } from "./identityProfileProjectionState"

type Identity = Pick<PublicIdentity, "personId" | "publicKey">
export type PrivateProfileObservation = { workspaceId: string; record: ChatRecord }
const observationSchema = z.object({ workspaceId: z.string().min(1).max(512), record: z.unknown() }).strict()
const registrySchema = z.object({ version: z.literal(1), personId: z.string().min(1),
  observations: z.array(observationSchema).max(1024) }).strict()

async function normalize(identity: Identity, observations: unknown[]): Promise<PrivateProfileObservation[]> {
  const unique = new Map<string, PrivateProfileObservation>()
  for (const value of observations) {
    const parsed = observationSchema.parse(value)
    const record = await verifyPrivateProfileObservation(parsed.record, identity)
    const observation = { workspaceId: parsed.workspaceId, record }
    unique.set(canonicalizeJson(observation), observation)
  }
  if (unique.size > 512) throw new Error("Too many pending private profile observations")
  return [...unique.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, value]) => value)
}

async function parseRegistry(identity: Identity, raw: string | null): Promise<PrivateProfileObservation[]> {
  if (raw === null) return []
  if (new TextEncoder().encode(raw).byteLength > 1024 * 1024) throw new Error("Private profile queue exceeds size limit")
  let value: unknown
  try { value = JSON.parse(raw) }
  catch { throw new Error("Invalid private profile projection queue") }
  if (value && typeof value === "object" && "version" in value && value.version !== 1) {
    throw new IdentityDeviceStateUpgradeRequiredError("Private profile projection queue requires an upgrade")
  }
  const parsed = registrySchema.parse(value)
  if (parsed.personId !== identity.personId) throw new Error("Private profile queue identity mismatch")
  return normalize(identity, parsed.observations)
}

function serialize(identity: Identity, observations: PrivateProfileObservation[]): string {
  const value = JSON.stringify({ version: 1, personId: identity.personId, observations })
  if (new TextEncoder().encode(value).byteLength > 1024 * 1024) throw new Error("Private profile queue exceeds size limit")
  return value
}

/** Signature preflight and queue capture finish before the shared identity activation transaction. */
export async function planIdentityProfileImport(identity: Identity, incoming: PrivateProfileObservation[]): Promise<LocalStatePlan> {
  identity = structuredClone(identity)
  incoming = structuredClone(incoming)
  const verified = await normalize(identity, incoming)
  const key = identityProfileProjectionKey(identity.personId), raw = await readLocal(key)
  const observations = await normalize(identity, [...await parseRegistry(identity, raw), ...verified])
  const value = serialize(identity, observations)
  return { conditions: [{ key, value: raw }], writes: value === raw || (!observations.length && raw === null) ? [] : [{ key, value }] }
}

export async function readIdentityProfileQueue(identity: Identity): Promise<PrivateProfileObservation[]> {
  identity = structuredClone(identity)
  return parseRegistry(identity, await readLocal(identityProfileProjectionKey(identity.personId)))
}

/** Remove exactly the confirmed record, preserving concurrently imported observations. */
export async function acknowledgeIdentityProfileProjection(identity: Identity, observation: PrivateProfileObservation,
  ensureCurrent: () => void): Promise<void> {
  identity = structuredClone(identity)
  const id = canonicalizeJson(structuredClone(observation)), key = identityProfileProjectionKey(identity.personId)
  for (let attempt = 0; attempt < 8; attempt++) {
    ensureCurrent()
    const raw = await readLocal(key), existing = await parseRegistry(identity, raw)
    const next = existing.filter(value => canonicalizeJson(value) !== id)
    if (next.length === existing.length) return
    ensureCurrent()
    if (await compareAndSwapLocal({ conditions: [{ key, value: raw }], writes: [{ key, value: serialize(identity, next) }] }, ensureCurrent)) return
  }
  throw new Error("Private profile queue changed repeatedly; retry required")
}
