import { z } from "zod"
import { normalizeIdentityRustyServicePin, verifyDeviceCertificateChain, type IdentityRustyServicePin } from "@meta-uber/mesh-identity"
import { canonicalizeJson, sha256Base64Url, verifyEnvelope, type SignedEnvelope } from "./identity"
import { signWithContext, signingEvidence, type VerifiedSigningContext } from "./signingContext"
import type { DeviceCertificate, PublicIdentity } from "./model"
import { isMemberProfileData } from "./avatarData"
import { normalizeDisplayName, validateDisplayName } from "../chat/names"

type ProfileField = "name" | "photo" | "rustyServicePin"
export type ProfilePresentationField = Exclude<ProfileField, "rustyServicePin">
export type ProfileValue = string | { avatarData: string | null; changedAt: string } | IdentityRustyServicePin
type Identity = Pick<PublicIdentity, "personId" | "publicKey">
type Clock = Record<string, number>
type ProfilePayload = { kind: "identity-profile-update"; version: 1; personId: string; deviceId: string;
  counter: number; context: Clock; field: ProfileField; value: ProfileValue; supersedesLegacy: string[] }
export type IdentityProfileOperation = { signed: SignedEnvelope<ProfilePayload>; certificates: DeviceCertificate[] }
type LegacyObservation = { id: string; field: ProfilePresentationField; value: string | { avatarData: string | null; changedAt: string } }
export type IdentityProfileState = { version: 1; personId: string; operations: IdentityProfileOperation[]; legacy: LegacyObservation[] }
const id = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const fieldSchema = z.enum(["name", "photo", "rustyServicePin"])
const presentationFieldSchema = z.enum(["name", "photo"])
const payloadSchema = z.object({ kind: z.literal("identity-profile-update"), version: z.literal(1), personId: id,
  deviceId: id, counter: counter.refine(value => value > 0), context: z.record(id, counter),
  field: fieldSchema, value: z.unknown(), supersedesLegacy: z.array(id).max(512) }).strict()
const operationSchema = z.object({ signed: z.object({ payload: payloadSchema, signerKeyId: id, signature: z.string().min(1).max(256) }).strict(),
  certificates: z.array(z.unknown()).min(1).max(32) }).strict()
const stateSchema = z.object({ version: z.literal(1), personId: id,
  operations: z.array(operationSchema).max(512),
  legacy: z.array(z.object({ id, field: presentationFieldSchema, value: z.unknown() }).strict()).max(512) }).strict()
const operationId = (operation: IdentityProfileOperation) => `${operation.signed.payload.deviceId}:${operation.signed.payload.counter}`
const compareOrdinal = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
const precedes = (before: IdentityProfileOperation, after: IdentityProfileOperation) =>
  (after.signed.payload.context[before.signed.payload.deviceId] ?? 0) >= before.signed.payload.counter

class IdentityProfileUpgradeRequiredError extends Error {
  readonly code = "identity-profile-upgrade-required"
  constructor() { super("Identity profile state requires an update") }
}

export function emptyIdentityProfileState(personId: string): IdentityProfileState {
  return { version: 1, personId: id.parse(personId), operations: [], legacy: [] }
}

function validateValue(field: ProfileField, value: unknown): asserts value is ProfileValue {
  if (field === "rustyServicePin") {
    const pin = value as Record<string, unknown> | null
    if (!pin || typeof pin !== "object" || Array.isArray(pin) || Object.keys(pin).sort().join(",") !== "origin,serviceId,servicePublicKey" ||
        typeof pin.origin !== "string" || typeof pin.serviceId !== "string" || typeof pin.servicePublicKey !== "string") {
      throw new Error("Invalid Rusty service pin")
    }
  } else if (field === "name") {
    if (typeof value !== "string" || validateDisplayName(value) || normalizeDisplayName(value) !== value) throw new Error("Invalid identity profile name")
  } else if (!value || !isMemberProfileData(JSON.stringify(value))) throw new Error("Invalid identity profile photo")
}

async function legacyId(field: ProfilePresentationField, value: Exclude<ProfileValue, IdentityRustyServicePin>): Promise<string> {
  return sha256Base64Url(new TextEncoder().encode(canonicalizeJson([field, value])))
}

function boundedSnapshot(value: unknown): unknown {
  const raw = JSON.stringify(value)
  if (!raw || new TextEncoder().encode(raw).byteLength > 1024 * 1024) throw new Error("Identity profile evidence exceeds size limit")
  const snapshot: unknown = JSON.parse(raw)
  if (snapshot && typeof snapshot === "object" && "version" in snapshot && snapshot.version !== 1) throw new IdentityProfileUpgradeRequiredError()
  return snapshot
}

/** Retained evidence is verified in full; timestamps are descriptive, never causal authority. */
export async function readIdentityProfileState(value: unknown, identity: Identity): Promise<IdentityProfileState> {
  identity = structuredClone(identity)
  const state = stateSchema.parse(boundedSnapshot(value)) as IdentityProfileState
  if (state.personId !== identity.personId) throw new Error("Identity profile person mismatch")
  const operations = new Map<string, IdentityProfileOperation>(), legacy = new Map<string, LegacyObservation>()
  for (const operation of state.operations) {
    await verifyOperation(operation, identity)
    if (operation.signed.payload.field === "rustyServicePin") {
      const normalized = await normalizeIdentityRustyServicePin(operation.signed.payload.value)
      if (canonicalizeJson(normalized) !== canonicalizeJson(operation.signed.payload.value)) throw new Error("Invalid Rusty service pin")
    }
    const key = operationId(operation), previous = operations.get(key)
    if (previous && canonicalizeJson(previous) !== canonicalizeJson(operation)) throw new Error("Identity profile device equivocation")
    operations.set(key, operation)
  }
  for (const observation of state.legacy) {
    validateValue(observation.field, observation.value)
    if (await legacyId(observation.field, observation.value) !== observation.id) throw new Error("Imported profile contents do not match their proof")
    legacy.set(observation.id, observation)
  }
  const result: IdentityProfileState = { version: 1, personId: state.personId,
    operations: [...operations.values()].sort((a, b) => compareOrdinal(operationId(a), operationId(b))),
    legacy: [...legacy.values()].sort((a, b) => compareOrdinal(a.id, b.id)) }
  validateCausality(result.operations)
  validateLegacyReferences(result.operations, legacy)
  return result
}

function validateLegacyReferences(operations: IdentityProfileOperation[], legacy: Map<string, LegacyObservation>): void {
  for (const operation of operations) for (const id of operation.signed.payload.supersedesLegacy) {
    const observation = legacy.get(id)
    if (!observation) throw new Error("Missing original profile observation")
    if (observation.field !== operation.signed.payload.field) throw new Error("Profile observation field does not match its update")
  }
}

async function verifyOperation(operation: IdentityProfileOperation, identity: Identity): Promise<void> {
  const payload = operation.signed.payload
  validateValue(payload.field, payload.value)
  if (payload.personId !== identity.personId || payload.deviceId !== operation.signed.signerKeyId ||
    (payload.context[payload.deviceId] ?? 0) !== payload.counter - 1 || Object.keys(payload.context).length > 256 ||
    new Set(payload.supersedesLegacy).size !== payload.supersedesLegacy.length) throw new Error("Invalid identity profile revision")
  const key = await verifyDeviceCertificateChain({ ...identity, displayName: "" }, payload.deviceId, operation.certificates, "MATCH/1")
  if (!await verifyEnvelope(operation.signed, key)) throw new Error("Invalid identity profile signature")
}

function validateCausality(operations: IdentityProfileOperation[]): void {
  const byId = new Map(operations.map(operation => [operationId(operation), operation]))
  for (const operation of operations) for (const [actor, count] of Object.entries(operation.signed.payload.context)) {
    if (!count) continue
    const dependency = byId.get(`${actor}:${count}`)
    if (!dependency) throw new Error("Missing signed identity profile causal evidence")
    for (const [seenActor, seenCount] of Object.entries(dependency.signed.payload.context)) {
      if ((operation.signed.payload.context[seenActor] ?? 0) < seenCount) throw new Error("Contradictory identity profile causal context")
    }
    if (precedes(operation, dependency)) throw new Error("Cyclic identity profile causal context")
  }
}

export async function observeLegacyIdentityProfile(state: IdentityProfileState, identity: Identity,
  field: ProfilePresentationField, value: Exclude<ProfileValue, IdentityRustyServicePin>): Promise<IdentityProfileState> {
  value = structuredClone(value)
  validateValue(field, value)
  const current = await readIdentityProfileState(state, identity)
  const observationId = await legacyId(field, value)
  if (current.legacy.some(observation => observation.id === observationId)) return current
  return readIdentityProfileState({ ...current, legacy: [...current.legacy, { field, value, id: observationId }] }, identity)
}

export async function mergeIdentityProfileState(left: IdentityProfileState, right: IdentityProfileState, identity: Identity): Promise<IdentityProfileState> {
  const snapshot = structuredClone([left, right])
  const [a, b] = await Promise.all(snapshot.map(state => readIdentityProfileState(state, identity)))
  const operations = new Map(a.operations.map(operation => [operationId(operation), operation]))
  for (const operation of b.operations) {
    const existing = operations.get(operationId(operation))
    if (existing && canonicalizeJson(existing) !== canonicalizeJson(operation)) throw new Error("Identity profile device equivocation")
    operations.set(operationId(operation), operation)
  }
  const legacy = new Map([...a.legacy, ...b.legacy].map(value => [value.id, value]))
  return readIdentityProfileState({ ...a, operations: [...operations.values()], legacy: [...legacy.values()] }, identity)
}

export async function createIdentityProfileOperation(context: VerifiedSigningContext, state: IdentityProfileState,
  identity: Identity, field: ProfilePresentationField, value: Exclude<ProfileValue, IdentityRustyServicePin>): Promise<IdentityProfileOperation> {
  value = structuredClone(value)
  validateValue(field, value)
  const current = await readIdentityProfileState(state, identity), evidence = signingEvidence(context)
  if (context.personId !== current.personId || evidence.identity.publicKey !== identity.publicKey) throw new Error("Identity profile signing context mismatch")
  const clock: Clock = {}
  for (const operation of current.operations) {
    const payload = operation.signed.payload
    clock[payload.deviceId] = Math.max(clock[payload.deviceId] ?? 0, payload.counter)
  }
  const next = (clock[context.deviceId] ?? 0) + 1
  if (!Number.isSafeInteger(next)) throw new Error("Identity profile revision exhausted")
  const supersedesLegacy = [...new Set([...current.legacy.filter(item => item.field === field).map(item => item.id),
    ...current.operations.filter(item => item.signed.payload.field === field).flatMap(item => item.signed.payload.supersedesLegacy)])].sort()
  const payload: ProfilePayload = { kind: "identity-profile-update", version: 1, personId: current.personId, deviceId: context.deviceId,
    counter: next, context: clock, field, value, supersedesLegacy }
  return { signed: await signWithContext(context, payload), certificates: evidence.certificates }
}

/** A conflict retains every incompatible value; only an explicit operation can supersede observed candidates. */
export function identityProfileValue(state: IdentityProfileState, field: ProfilePresentationField): {
  status: "empty" | "value" | "conflict"; values: Array<string | { avatarData: string | null; changedAt: string }>
} {
  const operations = state.operations.filter(item => item.signed.payload.field === field)
  const superseded = new Set(operations.flatMap(item => item.signed.payload.supersedesLegacy))
  const values = [...operations.filter(item => !operations.some(other => precedes(item, other))).map(item => item.signed.payload.value)
    .filter((value): value is string | { avatarData: string | null; changedAt: string } =>
      typeof value === "string" || (typeof value === "object" && value !== null && "avatarData" in value)),
    ...state.legacy.filter(item => item.field === field && !superseded.has(item.id)).map(item => item.value)]
  const distinct = new Map(values.map(value => [typeof value === "string" ? value : value.avatarData ?? "", value]))
  const selected = [...distinct.entries()].sort(([a], [b]) => compareOrdinal(a, b)).map(([, value]) => value)
  return { status: selected.length > 1 ? "conflict" : selected.length ? "value" : "empty", values: selected }
}
