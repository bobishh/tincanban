import * as Automerge from "@automerge/automerge/slim"
import { canonicalizeJson, verifyEnvelope, type LocalProfile } from "../domain/identity"
import type { TransactionReceipt, WorkspaceDocumentV2 } from "../domain/model"
import { assertWorkspaceEntityTransitions, assertWorkspaceTransition, type WorkspaceRole } from "../domain/permissions"
import type { WorkspaceChangeAuthorization } from "./workspaceChangeProofStore"
import { indexAdmissionOperations, touchedPathsForChange } from "../product-replica"

/** Only locally executed commands may extend an admitted frontier without replay. */
export async function assertLocalCommandTransition(
  base: Automerge.Doc<WorkspaceDocumentV2>, next: Automerge.Doc<WorkspaceDocumentV2>,
  receipt: TransactionReceipt, changeBytes: Uint8Array, authorizations: WorkspaceChangeAuthorization[],
  role: WorkspaceRole, profile: LocalProfile,
): Promise<void> {
  const heads = Automerge.getHeads(base).sort()
  const changes = Automerge.getChangesMetaSince(next, heads)
  const change = Automerge.decodeChange(changeBytes)
  const metadata = JSON.parse(change.message ?? "null") as { personId?: string; deviceId?: string } | null
  if (base.id !== next.id || changes.length !== 1 || changes[0]!.hash !== receipt.changeHash ||
    change.hash !== receipt.changeHash || canonicalizeJson(change.deps.slice().sort()) !== canonicalizeJson(heads) ||
    metadata?.personId !== profile.identity.personId || metadata.deviceId !== profile.device.deviceId ||
    !await matchesLocalAuthorization(authorizations, base.id, change.hash, profile)) {
    throw new Error("Local command does not extend the admitted workspace frontier")
  }
  const { objectParents, targetsByHash } = indexAdmissionOperations([changeBytes])
  for (const document of [base, next]) {
    const entitiesId = Automerge.getObjectId(document.entities)!
    objectParents.set(entitiesId, { parentId: "_root", key: "entities" })
    for (const id of receipt.changedEntityIds) indexObjectParents(document.entities[id], entitiesId, id, objectParents)
  }
  const touched = touchedPathsForChange(targetsByHash.get(change.hash), objectParents)
  if (!touched) {
    // Unreported/ambiguous targets still check this transition in full, never
    // trust the receipt's list as a substitute for actual changed objects.
    assertWorkspaceTransition(role, base, next, profile.identity.personId)
    return
  }
  // Check immutable roots without enumerating unrelated entities.
  assertWorkspaceTransition(role, { ...base, entities: {} }, { ...next, entities: {} }, profile.identity.personId)
  assertWorkspaceEntityTransitions(role, base.entities, next.entities, touched.entityIds, profile.identity.personId, next.id)
}

async function matchesLocalAuthorization(authorizations: WorkspaceChangeAuthorization[], workspaceId: string,
  hash: string, profile: LocalProfile): Promise<boolean> {
  const authorization = authorizations[0]
  if (authorizations.length !== 1 || !authorization) return false
  const payload = authorization.signed.payload
  return authorization.publicKey === profile.identity.publicKey && payload.workspaceId === workspaceId &&
    payload.personId === profile.identity.personId && payload.deviceId === profile.device.deviceId &&
    canonicalizeJson(payload.hashes) === canonicalizeJson([hash]) &&
    await verifyEnvelope(authorization.signed, profile.device.publicKey)
}

function indexObjectParents(value: unknown, parentId: string, key: string,
  parents: Map<string, { parentId: string; key: string }>): void {
  if (!value || typeof value !== "object") return
  const objectId = Automerge.getObjectId(value)
  if (!objectId) return
  parents.set(objectId, { parentId, key })
  for (const [childKey, child] of Object.entries(value)) indexObjectParents(child, objectId, childKey, parents)
}
