import type { WorkspaceMeshCredential, WorkspacePeerRecord } from "./peerStore"
import type { ScopeAuthoritySnapshot } from "./durableMeshBase"
import { compareAndSwapLocal, readLocal } from "../localDb"

export type LocalWorkspaceOwnerReference = { workspaceId: string; ownerGrantHash: string }
export type LocalWorkspaceTransferPlan = { workspaceId: string; previousOwnerPersonId: string; sourceCredentialHash: string;
  nextCredential: WorkspaceMeshCredential; peers: WorkspacePeerRecord[]; scopeAuthoritySnapshot?: ScopeAuthoritySnapshot }
export type LocalWorkspaceOwnershipIntent = { version: 1; stage: "requested" | "transferred"; sourcePersonId: string;
  targetPersonId: string; targetPublicKey: string; deviceId: string; workspaceIds: string[]; plans?: LocalWorkspaceTransferPlan[];
  references?: LocalWorkspaceOwnerReference[] }

const localOwnershipIntentKey = (deviceId: string) => `tincanban.local-workspace-ownership-intent.v1.${deviceId}`

export async function hasPendingLocalWorkspaceOwnershipIntent(deviceId: string): Promise<boolean> {
  return (await readLocalWorkspaceOwnershipIntent(deviceId)) !== null
}

export async function readLocalWorkspaceOwnershipIntent(deviceId: string): Promise<LocalWorkspaceOwnershipIntent | null> {
  const raw = await readLocal(localOwnershipIntentKey(deviceId))
  return raw === null ? null : parseLocalOwnershipIntent(raw)
}

export async function persistLocalWorkspaceOwnershipIntent(intent: LocalWorkspaceOwnershipIntent): Promise<void> {
  const key = localOwnershipIntentKey(intent.deviceId)
  const next = JSON.stringify(intent)
  if (new TextEncoder().encode(next).byteLength > 4 * 1024 * 1024) {
    throw new Error("Selected local boards exceed the safe transfer recovery limit")
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const previous = await readLocal(key)
    if (previous !== null && shouldKeepIntent(parseLocalOwnershipIntent(previous), intent)) return
    if (previous === next) return
    if (await compareAndSwapLocal({ conditions: [{ key, value: previous }], writes: [{ key, value: next }] })) return
  }
  throw new Error("Local workspace transfer intent changed repeatedly; retry required")
}

export async function clearLocalWorkspaceOwnershipIntent(intent: LocalWorkspaceOwnershipIntent): Promise<boolean> {
  const key = localOwnershipIntentKey(intent.deviceId)
  const expectedRaw = JSON.stringify(intent)
  return compareAndSwapLocal({ conditions: [{ key, value: expectedRaw }], writes: [{ key, value: null }] })
}

function shouldKeepIntent(existing: LocalWorkspaceOwnershipIntent, next: LocalWorkspaceOwnershipIntent): boolean {
  const sameRequest = existing.sourcePersonId === next.sourcePersonId && existing.targetPersonId === next.targetPersonId &&
    existing.targetPublicKey === next.targetPublicKey && existing.deviceId === next.deviceId &&
    JSON.stringify(existing.workspaceIds) === JSON.stringify(next.workspaceIds)
  if (!sameRequest) throw new Error("A different local workspace transfer must be completed first")
  if (existing.stage === "transferred") {
    if (next.stage !== "transferred" || JSON.stringify(existing.references) !== JSON.stringify(next.references)) {
      throw new Error("Completed local workspace transfer cannot be replaced")
    }
    return true
  }
  if (next.stage !== "requested" || !existing.plans) return false
  if (!next.plans || JSON.stringify(existing.plans) === JSON.stringify(next.plans)) return true
  throw new Error("Local workspace transfer plan changed; retry with the original approval")
}

function parseLocalOwnershipIntent(raw: string): LocalWorkspaceOwnershipIntent {
  let value: unknown
  try { value = JSON.parse(raw) as unknown } catch { throw new Error("Local workspace transfer intent is malformed") }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Local workspace transfer intent is invalid")
  const record = value as Partial<LocalWorkspaceOwnershipIntent>
  if (!hasValidIntentFields(record) || !hasExactIntentKeys(record)) {
    throw new Error("Local workspace transfer intent is invalid")
  }
  return record as LocalWorkspaceOwnershipIntent
}

function hasValidIntentFields(record: Partial<LocalWorkspaceOwnershipIntent>): boolean {
  return record.version === 1 && (record.stage === "requested" || record.stage === "transferred") &&
    typeof record.sourcePersonId === "string" && typeof record.targetPersonId === "string" &&
    typeof record.targetPublicKey === "string" && typeof record.deviceId === "string" && isValidWorkspaceIds(record.workspaceIds) &&
    validIntentPlans(record) && validIntentReferences(record)
}

function isValidWorkspaceIds(ids: unknown): ids is string[] {
  return Array.isArray(ids) && ids.length > 0 && ids.length <= 512 &&
    ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 512) && new Set(ids).size === ids.length
}

function validIntentPlans(record: Partial<LocalWorkspaceOwnershipIntent>): boolean {
  if (record.plans === undefined) return true
  if (record.stage !== "requested" || !Array.isArray(record.plans) || record.plans.length !== record.workspaceIds!.length) return false
  return record.plans.every((plan, index) => plan && typeof plan === "object" &&
    plan.workspaceId === record.workspaceIds![index] && typeof plan.previousOwnerPersonId === "string" &&
    typeof plan.sourceCredentialHash === "string" && !!plan.nextCredential &&
    plan.nextCredential.workspaceId === plan.workspaceId && Array.isArray(plan.peers) &&
    plan.peers.every(peer => peer && typeof peer === "object" && peer.workspaceId === plan.workspaceId))
}

function validIntentReferences(record: Partial<LocalWorkspaceOwnershipIntent>): boolean {
  if (record.stage !== "transferred") return record.references === undefined
  return Array.isArray(record.references) && record.references.length === record.workspaceIds!.length &&
    record.references.every(reference => reference && typeof reference === "object" &&
      typeof reference.workspaceId === "string" && typeof reference.ownerGrantHash === "string")
}

function hasExactIntentKeys(record: Partial<LocalWorkspaceOwnershipIntent>): boolean {
  const keys = Object.keys(record).sort().join(",")
  if (record.stage === "requested") return keys === (record.plans
    ? "deviceId,plans,sourcePersonId,stage,targetPersonId,targetPublicKey,version,workspaceIds"
    : "deviceId,sourcePersonId,stage,targetPersonId,targetPublicKey,version,workspaceIds")
  return keys === "deviceId,references,sourcePersonId,stage,targetPersonId,targetPublicKey,version,workspaceIds"
}
