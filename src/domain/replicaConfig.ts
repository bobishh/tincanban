import { rustyOrigin as blindOrigin } from "@meta-uber/mesh-replication/rusty-replica"
import { decodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import type { BlindReplicaConfig, PrivateReplicaConfig, IdentityReplicaConfig } from "../product-replica"
import { parseReplicaContentKeys, type ReplicaContentKeys } from "./replicaContentKeys"

export function parseReplicaConfig(text: string): BlindReplicaConfig {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error("Invalid Rusty local settings")
  if ((value.purpose !== undefined && value.purpose !== "workspace") || Object.hasOwn(value, "personId")) {
    throw new Error("Invalid Rusty workspace purpose")
  }
  if (Object.hasOwn(value, "minimumWriterVersion") && value.minimumWriterVersion !== 2) {
    throw new Error("Invalid Rusty writer version")
  }
  validateConnectionFields(value)
  const keys = validateCredentialFields(value)
  validateLocalFields(value)
  const input = value as unknown as BlindReplicaConfig
  return { purpose: "workspace", origin: blindOrigin(input.origin), scopeId: input.scopeId, workspaceId: input.workspaceId, servicePublicKey: input.servicePublicKey,
    readToken: input.readToken, writeToken: input.writeToken, ...keys, policyRevision: input.policyRevision,
    cursor: input.cursor, lastUploaded: input.lastUploaded, ...(input.removalPending ? { removalPending: true } : {}),
    ...(input.minimumWriterVersion === 2 ? { minimumWriterVersion: 2 as const } : {}),
    ...(input.preferenceRevision ? { preferenceRevision: input.preferenceRevision } : {}) }
}

/** Parse a tagged same-person preference; an expected person binding is mandatory for identity scopes. */
export function parsePrivateReplicaConfig(text: string, expectedPersonId?: string): PrivateReplicaConfig {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) throw new Error("Invalid private Rusty settings")
  if (value.purpose === undefined || value.purpose === "workspace") return parseReplicaConfig(text)
  if (Object.hasOwn(value, "minimumWriterVersion")) throw new Error("Rusty writer version is workspace-only")
  if (value.purpose !== "identity" || Object.hasOwn(value, "workspaceId")) throw new Error("Invalid private Rusty purpose")
  validateIdentityFields(value, expectedPersonId)
  validateConnectionFields(value, false)
  const keys = validateCredentialFields(value)
  validateLocalFields(value)
  const input = value as unknown as IdentityReplicaConfig
  return { purpose: "identity", personId: input.personId, origin: blindOrigin(input.origin), scopeId: input.scopeId,
    servicePublicKey: input.servicePublicKey, readToken: input.readToken, writeToken: input.writeToken,
    ...keys, policyRevision: input.policyRevision,
    cursor: input.cursor, lastUploaded: input.lastUploaded, ...(input.removalPending ? { removalPending: true } : {}),
    ...(input.preferenceRevision ? { preferenceRevision: input.preferenceRevision } : {}) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value as object) as object | null
  return prototype === Object.prototype || prototype === null
}

function validateConnectionFields(value: Record<string, unknown>, requireWorkspace = true): void {
  const isId = (item: unknown) => typeof item === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item)
  const isToken = (item: unknown) => isId(item) && (item as string).length >= 43
  const workspaceId = value.workspaceId
  if (!isId(value.scopeId) || (requireWorkspace && (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 256)) ||
    !isToken(value.readToken) || !isToken(value.writeToken)) throw new Error("Invalid Rusty local settings")
}

function validateIdentityFields(value: Record<string, unknown>, expectedPersonId?: string): void {
  const personId = value.personId
  if (typeof personId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(personId) ||
    (expectedPersonId !== undefined && personId !== expectedPersonId)) throw new Error("Private Rusty identity mismatch")
}

function validateCredentialFields(value: Record<string, unknown>): ReplicaContentKeys {
  const isPositive = (item: unknown) => typeof item === "number" && Number.isSafeInteger(item) && item > 0
  const keys = parseReplicaContentKeys(value)
  if (!isPositive(value.policyRevision) || typeof value.servicePublicKey !== "string" ||
    decodeBlindBytes(value.servicePublicKey).length !== 32) throw new Error("Invalid Rusty key or revision")
  return keys
}

function validateLocalFields(value: Record<string, unknown>): void {
  const cursor = value.cursor
  const hash = value.lastUploaded
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 0 || typeof hash !== "string" ||
    !(hash === "" || /^[A-Za-z0-9_-]{43}$/.test(hash)) || !validLocalPreferenceRevision(value.preferenceRevision)) {
    throw new Error("Invalid Rusty local settings")
  }
  if (value.removalPending !== undefined && typeof value.removalPending !== "boolean") throw new Error("Invalid Rusty removal state")
}

function validLocalPreferenceRevision(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) return false
  const parts = value.split("|")
  if (parts.length > 32) return false
  const normalized = parts.map(part => {
    const separator = part.lastIndexOf(":")
    const actor = part.slice(0, separator)
    const counterText = part.slice(separator + 1)
    const counter = Number(counterText)
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(actor) || ["__proto__", "constructor", "prototype"].includes(actor) ||
      !/^[1-9]\d*$/.test(counterText) || !Number.isSafeInteger(counter) || counter < 1) return null
    return `${actor}:${counter}`
  })
  return normalized.every((part): part is string => part !== null) && new Set(normalized).size === normalized.length &&
    [...normalized].sort().join("|") === value
}
