import { z } from "zod"
import { canonicalizeJson } from "../domain/identity"
import { readLocal } from "../localDb"
import type { PrivateReplicaConfig } from "./blindReplication"
import { blindHash } from "./blindClient"
import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { parsePrivateReplicaConfig } from "./blindReplicaConfig"
import { assertRetainsReplicaContentKeys, rotateReplicaContentKeys } from "./replicaContentKeys"
import { parseReplicaCredentialConflictFreeze } from "./replicaCredentialConflictFreeze"
import { privateReplicaBinding } from "./privateReplicaBinding"

export type ReplicaCredentialFreeze = {
  version: 1
  id: string
  personId: string
  signerDeviceId: string
  revokedDeviceId: string
  origin: string
  servicePublicKey: string
  resources: Array<{ previous: PrivateReplicaConfig; next: PrivateReplicaConfig }>
}
const encoder = new TextEncoder()
const freezeKeys = new Map<string, Promise<string>>()

export function replicaCredentialFreezeKey(personId: string, origin: string): Promise<string> {
  origin = blindOrigin(origin)
  if (!personId || personId.length > 128) throw new Error("Invalid credential transition identity")
  const binding = canonicalizeJson([personId, origin])
  let key = freezeKeys.get(binding)
  if (!key) {
    if (freezeKeys.size >= 64) freezeKeys.delete(freezeKeys.keys().next().value!)
    key = blindHash(encoder.encode(binding)).then(hash => `tincanban.replica-credential-freeze.v1.${hash}`)
    freezeKeys.set(binding, key)
  }
  return key
}

const freezeHeaderSchema = z.strictObject({
  version: z.literal(1), id: z.string().regex(/^[0-9a-f-]{36}$/i), personId: z.string(), origin: z.string(),
  signerDeviceId: z.string().min(1).max(128), revokedDeviceId: z.string().min(1).max(128), servicePublicKey: z.string(),
  resources: z.array(z.strictObject({ previous: z.unknown(), next: z.unknown() })).min(1).max(128),
}).refine(value => value.signerDeviceId !== value.revokedDeviceId)

function assertResourceBinding(previous: PrivateReplicaConfig, next: PrivateReplicaConfig, origin: string, servicePublicKey: string): void {
  if (previous.origin !== origin || previous.servicePublicKey !== servicePublicKey || previous.removalPending ||
      !previous.preferenceRevision || next.preferenceRevision || next.keyEpoch !== previous.keyEpoch + 1 ||
      next.cursor !== previous.cursor || next.lastUploaded !== "" || next.readToken === previous.readToken || next.writeToken === previous.writeToken) {
    throw new Error("Saved credential transition resource binding changed")
  }
}

function parseFreeze(raw: string, personId: string, origin: string): ReplicaCredentialFreeze {
  if (encoder.encode(raw).length > 4 * 1024 * 1024) throw new Error("Credential transition exceeds storage bound")
  const parsed = freezeHeaderSchema.safeParse(JSON.parse(raw))
  if (!parsed.success || parsed.data.personId !== personId || parsed.data.origin !== origin) throw new Error("Invalid saved credential transition")
  const value = parsed.data
  const scopes = new Set<string>()
  const resources = value.resources.map(resource => {
    const previous = parsePrivateReplicaConfig(JSON.stringify(resource.previous), personId)
    const next = parsePrivateReplicaConfig(JSON.stringify(resource.next), personId)
    assertResourceBinding(previous, next, origin, value.servicePublicKey)
    assertRetainsReplicaContentKeys(previous, next)
    const expected = { ...previous, ...rotateReplicaContentKeys(previous, next.contentKey),
      readToken: next.readToken, writeToken: next.writeToken, lastUploaded: "" }
    delete expected.preferenceRevision
    if (canonicalizeJson(expected) !== canonicalizeJson(next) || scopes.has(previous.scopeId)) throw new Error("Saved credential transition changed its resource or policy")
    scopes.add(previous.scopeId)
    return { previous, next }
  })
  return { ...value, resources }
}
export { parseFreeze as parseReplicaCredentialFreeze }

function validateOrdinaryFreeze(raw: string, personId: string, origin: string): void {
  if (encoder.encode(raw).length > 4 * 1024 * 1024) throw new Error("Credential transition exceeds storage bound")
  const value = JSON.parse(raw) as { kind?: string }
  if (value?.kind === "rusty-credential-conflict-freeze") parseReplicaCredentialConflictFreeze(value, personId, origin)
  else parseFreeze(raw, personId, origin)
}

export async function readReplicaCredentialFreeze(personId: string, origin: string): Promise<ReplicaCredentialFreeze | undefined> {
  origin = blindOrigin(origin)
  const raw = await readLocal(await replicaCredentialFreezeKey(personId, origin))
  return raw === null ? undefined : parseFreeze(raw, personId, origin)
}

/** All ordinary writers at this origin stop, including a newly discovered scope omitted by an older in-flight loop. */
export async function assertReplicaCredentialsUnfrozen(personId: string, config: Pick<PrivateReplicaConfig, "origin">): Promise<void> {
  await replicaCredentialOriginCondition(personId, config.origin)
}

export async function replicaCredentialOriginCondition(personId: string, origin: string): Promise<{ key: string; value: null }> {
  origin = blindOrigin(origin)
  const key = await replicaCredentialFreezeKey(personId, origin)
  const raw = await readLocal(key)
  if (raw !== null) {
    validateOrdinaryFreeze(raw, personId, origin)
    throw new Error("Rusty credential transition is pending; ordinary replication is frozen")
  }
  return { key, value: null }
}

/** Include this exact observation in the progress transaction so a concurrent freeze wins atomically. */
export async function replicaCredentialFreezeCondition(personId: string, config: PrivateReplicaConfig,
  maintenance?: ReplicaCredentialFreeze): Promise<{ key: string; value: string | null }> {
  const key = await replicaCredentialFreezeKey(personId, config.origin)
  const value = await readLocal(key)
  if (maintenance) {
    const current = value === null ? undefined : parseFreeze(value, personId, blindOrigin(config.origin))
    if (canonicalizeJson(current ?? null) !== canonicalizeJson(maintenance) || maintenance.personId !== personId ||
      !maintenance.resources.some(resource => privateReplicaBinding(personId, resource.previous) === privateReplicaBinding(personId, config))) {
      throw new Error("Credential transition or its exact original resource changed")
    }
  } else if (value !== null) {
    validateOrdinaryFreeze(value, personId, blindOrigin(config.origin))
    throw new Error("Rusty credential transition is pending; ordinary replication is frozen")
  }
  return { key, value }
}
