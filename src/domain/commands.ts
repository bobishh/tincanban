import * as Automerge from "@automerge/automerge/slim"
import type {
  ChangeProof,
  CommandResult,
  Heads,
  TransactionMetadataV1,
  TransactionReceipt,
  WorkspaceDocumentV2,
  WorkspaceEntity,
} from "./model"
import { canonicalizeJson, sha256Base64Url, type LocalProfile } from "./identity"
import { createActorBinding, createChangeProof } from "./transactionProofs"
import { prepareCommand } from "./commandHandlers"
import { err, type Command, type ExecuteResult } from "./commandTypes"
import { verifyApplicationSourceDigest } from "./commandApplicationSource"
import type { VerifiedSigningContext } from "./signingContext"

export { type Command, type ExecuteResult } from "./commandTypes"
export type CommandSigningContext = (purpose: "actor-binding" | "change-proof",
  binding: Record<string, string | number>) => Promise<VerifiedSigningContext>

export async function executeCommand(
  doc: Automerge.Doc<WorkspaceDocumentV2>, command: Command, profile: LocalProfile, actorId?: string,
  authorityGrantHash?: string, signingContext?: CommandSigningContext,
): Promise<ExecuteResult> {
  return executeCommandInternal(doc, command, profile, true, actorId, authorityGrantHash, signingContext)
}

/** Consumes a private document handle. Caller must release it once, including on failure. */
export async function executeOwnedCommand(
  doc: Automerge.Doc<WorkspaceDocumentV2>, command: Command, profile: LocalProfile, actorId?: string,
  authorityGrantHash?: string,
  signingContext?: CommandSigningContext,
): Promise<ExecuteResult> {
  return executeCommandInternal(doc, command, profile, false, actorId, authorityGrantHash, signingContext)
}

async function executeCommandInternal(doc: Automerge.Doc<WorkspaceDocumentV2>, command: Command, profile: LocalProfile,
  copy: boolean, actorId?: string, authorityGrantHash?: string, signingContext?: CommandSigningContext): Promise<ExecuteResult> {
  if (command.kind === "recordApplicationSource" || command.kind === "createItemWithApplicationSource") {
    try {
      command = structuredClone(command)
      command = { ...command, data: await verifyApplicationSourceDigest(command.data) }
    }
    catch (error) { return err("invalid_input", error instanceof Error ? error.message : "Invalid application source") }
  }
  const transactionId = crypto.randomUUID()
  const beforeHeads = Automerge.getHeads(doc).sort()
  const prepared = prepareCommand(doc, command, new Date().toISOString(), beforeHeads, profile.identity.personId)
  if (!prepared.ok) return prepared
  const metadata = commandMetadata(transactionId, command.kind, prepared.value.changedEntityIds, profile, authorityGrantHash)
  let owned = copy ? Automerge.clone(doc) : doc
  try {
    owned = Automerge.change(owned, { message: JSON.stringify(metadata) }, draft => prepared.value.apply(draft))
    const changeBytes = Automerge.getLastLocalChange(owned)
    if (!changeBytes) {
      if (copy) Automerge.free(owned)
      return err("storage_failed", "Automerge produced no change")
    }
    return await completeCommand(owned, changeBytes, transactionId, beforeHeads, prepared.value.changedEntityIds, profile, actorId, signingContext)
  } catch (error) {
    if (copy) Automerge.free(owned)
    throw error
  }
}

export async function executeReviewedWorkspaceChange(
  doc: Automerge.Doc<WorkspaceDocumentV2>, changeHash: string,
  patch: { root: Partial<Pick<WorkspaceDocumentV2, "title" | "archivedAt" | "migration" | "leads" | "documents" | "templates" | "artifacts">>;
    entities: Array<{ id: string; value?: WorkspaceEntity | null; changes?: Record<string, unknown>; removedKeys?: string[] }> },
  profile: LocalProfile, authorityGrantHash?: string,
  signingContext?: CommandSigningContext,
): Promise<ExecuteResult> {
  if (patch.entities.some(change => doc.entities[change.id]?.kind === "application_source" ||
    change.id.startsWith("application-source:") && Boolean(doc.entities[change.id]))) {
    return err("permission_denied", "Application source records are immutable")
  }
  const transactionId = crypto.randomUUID()
  const beforeHeads = Automerge.getHeads(doc).sort()
  const changedEntityIds = patch.entities.map(change => change.id).sort()
  const metadata = { ...commandMetadata(transactionId, "reviewQuarantinedChange", changedEntityIds, profile, authorityGrantHash),
    sourceChangeHash: changeHash }
  let owned = Automerge.clone(doc)
  try {
    owned = Automerge.change(owned, { message: JSON.stringify(metadata) }, draft => {
      for (const [key, value] of Object.entries(patch.root)) {
        if (value === undefined) delete (draft as unknown as Record<string, unknown>)[key]
        else (draft as unknown as Record<string, unknown>)[key] = value
      }
      for (const change of patch.entities) {
        if (change.value === null) { delete draft.entities[change.id]; continue }
        if (change.value !== undefined) { draft.entities[change.id] = JSON.parse(JSON.stringify(change.value)) as WorkspaceEntity; continue }
        const entity = draft.entities[change.id] as unknown as Record<string, unknown> | undefined
        if (!entity) throw new Error(`Reviewed entity ${change.id} is no longer present`)
        for (const key of change.removedKeys ?? []) delete entity[key]
        for (const [key, value] of Object.entries(change.changes ?? {})) entity[key] = JSON.parse(JSON.stringify(value))
      }
    })
    const changeBytes = Automerge.getLastLocalChange(owned)
    if (!changeBytes) { Automerge.free(owned); return err("storage_failed", "Automerge produced no reviewed change") }
    return await completeCommand(owned, changeBytes, transactionId, beforeHeads, changedEntityIds, profile, undefined, signingContext)
  } catch (error) { Automerge.free(owned); throw error }
}

function commandMetadata(transactionId: string, action: string, entityIds: string[], profile: LocalProfile,
  authorityGrantHash?: string): TransactionMetadataV1 {
  return { kind: "workspace-change-metadata", version: 1, transactionId, action, entityIds,
    personId: profile.identity.personId, deviceId: profile.device.deviceId,
    ...(authorityGrantHash ? { authorityGrantHash } : {}) }
}

async function completeCommand(
  newDoc: Automerge.Doc<WorkspaceDocumentV2>, changeBytes: Uint8Array, transactionId: string, beforeHeads: Heads,
  changedEntityIds: string[], profile: LocalProfile, actorId?: string, signingContext?: CommandSigningContext,
): Promise<ExecuteResult> {
  const changeHash = Automerge.decodeChange(changeBytes).hash
  const actor = actorId || profile.device.deviceId
  const bindingContext = await signingContext?.("actor-binding", { documentId: newDoc.id, actorId: actor })
  const binding = await createActorBinding(profile, newDoc.id, actor, bindingContext)
  const bindingHash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(binding)))
  const proofContext = await signingContext?.("change-proof", { documentId: newDoc.id, changeHash, actorBindingHash: bindingHash })
  const proof = await createChangeProof(profile, newDoc.id, changeHash, bindingHash, proofContext)
  const receipt: TransactionReceipt = {
    transactionId,
    beforeHeads,
    afterHeads: Automerge.getHeads(newDoc).sort(),
    changeHash,
    changedEntityIds,
    saved: true,
  }
  return { ok: true, value: { newDoc, receipt, proof } }
}

export function createCommandQueue(initialDoc: Automerge.Doc<WorkspaceDocumentV2>, profile: LocalProfile, actorId?: string) {
  let currentDoc = initialDoc
  let queue: Promise<unknown> = Promise.resolve()
  return {
    getDocument(): Automerge.Doc<WorkspaceDocumentV2> { return currentDoc },
    transact(command: Command): Promise<CommandResult<{ receipt: TransactionReceipt; proof: ChangeProof }>> {
      const run = async () => queueResult(await executeCommand(currentDoc, command, profile, actorId), value => { currentDoc = value.newDoc })
      const next = queue.then(run, run)
      queue = next
      return next
    },
  }
}

function queueResult(
  result: ExecuteResult,
  save: (value: Extract<ExecuteResult, { ok: true }>["value"]) => void,
): CommandResult<{ receipt: TransactionReceipt; proof: ChangeProof }> {
  if (!result.ok) return result
  save(result.value)
  return { ok: true, value: { receipt: result.value.receipt, proof: result.value.proof } }
}
