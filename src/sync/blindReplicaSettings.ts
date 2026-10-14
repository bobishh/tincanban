import { readLocal } from "../localDb"
import { blindOrigin } from "./blindOrigin"
import { decodeBlindBytes } from "./blindEnvelope"
import type { BlindReplicaConfig } from "./blindReplication"

export async function loadReplicaConfigs(owner: string): Promise<BlindReplicaConfig[]> {
  const saved = await readLocal(`tincanban.blind-replicas.v1.${owner}`)
  const values: unknown = saved ? JSON.parse(saved) as unknown : []
  if (!Array.isArray(values) || values.length > 128) throw new Error("Invalid Rusty local settings")
  return values.map(value => parseReplicaConfig(JSON.stringify(value)))
}

export function parseReplicaConfig(text: string): BlindReplicaConfig {
  const input = JSON.parse(text) as BlindReplicaConfig
  if (!input || typeof input !== "object") throw new Error("Invalid Rusty local settings")
  const validId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0
  const validToken = (value: string) => validId(value) && value.length >= 43
  const validWorkspace = typeof input.workspaceId === "string" && input.workspaceId.length > 0 && input.workspaceId.length <= 256
  const validEpoch = positive(input.keyEpoch) && positive(input.policyRevision)
  const validCursor = Number.isSafeInteger(input.cursor) && input.cursor >= 0
  const validHash = typeof input.lastUploaded === "string" && (input.lastUploaded === "" || /^[A-Za-z0-9_-]{43}$/.test(input.lastUploaded))
  if ([validId(input.scopeId), validWorkspace, validEpoch, validCursor, validHash, validToken(input.readToken), validToken(input.writeToken)].some(valid => !valid)) {
    throw new Error("Invalid Rusty local settings")
  }
  if (decodeBlindBytes(input.contentKey).length !== 32 || decodeBlindBytes(input.servicePublicKey).length !== 32) throw new Error("Invalid Rusty key")
  if (input.removalPending !== undefined && typeof input.removalPending !== "boolean") throw new Error("Invalid Rusty removal state")
  return { origin: blindOrigin(input.origin), scopeId: input.scopeId, workspaceId: input.workspaceId, servicePublicKey: input.servicePublicKey,
    readToken: input.readToken, writeToken: input.writeToken, contentKey: input.contentKey, keyEpoch: input.keyEpoch, policyRevision: input.policyRevision, cursor: input.cursor, lastUploaded: input.lastUploaded, ...(input.removalPending ? { removalPending: true } : {}) }
}
