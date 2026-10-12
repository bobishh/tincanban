import { canonicalizeJson, publicKeyId, signEnvelope, type LocalProfile } from "../domain/identity"
import { automationTypes, parseAutomationDefinition, type AutomationDefinition } from "../domain/automationContract"
import { hasEntityKind, type DeviceCertificate, type WorkspaceDocumentV2 } from "../domain/model"
import { createAutomationWorkspaceGrant, validateCertificateChain, verifyWorkspaceGrant } from "../domain/proofs"
import { encodeBlindBytes } from "../sync/blindEnvelope"
import { automationEntityId, automationLifecycle, isAutomationOrigin } from "../domain/automationLifecycle"
import { parseAutomationApproval } from "../domain/automationApproval"
import { verifyAutomationDefinition } from "../domain/automationDefinitionProof"

export type AutomationConfiguration = Pick<AutomationDefinition, "name" | "type" | "typeVersion" | "parameters">

export type AutomationWorkerIdentity = {
  integrationId?: string
  origin: string
  personId: string
  identityPublicKey: string
  deviceId: string
  devicePublicKey: string
  deviceCertificate: DeviceCertificate
}

type AutomationAuthorization = { version: 1; records: unknown[]; authority: {
  currentOwner: { personId: string; publicKey?: string; certificates?: DeviceCertificate[] }; currentEpoch: number
} }

/** Produces private activation data only after local owner approval. */
export async function prepareAutomationActivation<
  A extends AutomationAuthorization,
  B extends { workspaceId: string },
>(input: { profile: LocalProfile; doc: WorkspaceDocumentV2; bytes: Uint8Array; authorization: A;
  blind: B; worker: AutomationWorkerIdentity; expiresAt: number; configuration?: AutomationConfiguration }) {
  const { profile, doc, authorization, blind, worker } = input
  if (authorization.authority.currentOwner.personId !== profile.identity.personId || blind.workspaceId !== doc.id) {
    throw new Error("Only the verified workspace owner can approve automation")
  }
  await validateWorkerIdentity(profile, worker)
  const bindings = selectAutomationBindings(doc)
  if (input.configuration && !input.configuration.parameters.sources.includes("email")) delete bindings.columns.applied
  const existing = doc.entities[automationEntityId(worker.integrationId ?? worker.personId)]
  let expiresAt = input.expiresAt
  const initial = { document: encodeBlindBytes(input.bytes), authorization, chat: null }
  if (existing) {
    if (!hasEntityKind(existing, "automation")) throw new Error("Automation instance ID is occupied")
    const previous = parseAutomationApproval(existing.approval)
    expiresAt = Math.min(expiresAt, previous.grant.payload.automation.expiresAt)
    const legacyBindings = { ...bindings, columns: { ...bindings.columns } }
    if (!previous.grant.payload.automation.columns.applied) delete legacyBindings.columns.applied
    const approval = await existingAutomationApproval(existing, profile, worker, authorization, doc.id, legacyBindings)
    if (!input.configuration) return { version: 2 as const, workspaceId: doc.id, blind, ...approval, bindings: legacyBindings, initial }

  }
  const grant = await createAutomationWorkspaceGrant(profile, doc.id, worker.personId, {
    version: 1, boardId: bindings.boardId, columns: bindings.columns, fieldIds: Object.values(bindings.fieldIds), expiresAt,
  }, authorization.authority.currentEpoch)
  const definition: AutomationDefinition = parseAutomationDefinition({
    kind: "automation-definition", version: 1, id: worker.integrationId ?? worker.personId,
    name: "Job intake", type: "job-intake", typeVersion: 1,
    parameters: { sources: ["website", "email"] }, ...input.configuration, permissions: automationTypes[0].permissions,
    scope: { workspaceId: doc.id, boardId: bindings.boardId, grantId: grant.payload.grantId },
  })
  return { version: 2 as const, workspaceId: doc.id, blind, grant, bindings, initial,
    definition: await signEnvelope(profile.privateKeys.devicePrivateKey, definition, profile.device.deviceId) }
}

async function validateWorkerIdentity(profile: LocalProfile, worker: AutomationWorkerIdentity): Promise<void> {
  const certificate = worker.deviceCertificate
  if (worker.personId === profile.identity.personId || worker.personId !== await publicKeyId(worker.identityPublicKey)
    || worker.deviceId !== await publicKeyId(worker.devicePublicKey)
    || certificate.payload.personId !== worker.personId || certificate.payload.deviceId !== worker.deviceId
    || certificate.payload.devicePublicKey !== worker.devicePublicKey
    || !(await validateCertificateChain(certificate, worker.identityPublicKey, [])).ok) {
    throw new Error("Worker identity certificate is invalid")
  }
  if (!isAutomationOrigin(worker.origin)) throw new Error("Worker public identity must include its service origin")
}

function selectAutomationBindings(doc: WorkspaceDocumentV2) {
  const boards = Object.values(doc.entities).filter(entity => hasEntityKind(entity, "board") && !entity.archivedAt && entity.preset?.key === "job-search")
  if (boards.length !== 1) throw new Error("Select a workspace with one active job-search board")
  const board = boards[0]
  if (!hasEntityKind(board, "board") || !board.preset) throw new Error("Job-search bindings are missing")
  const id = (key: string, kind: "column" | "field") => {
    const entityId = board.preset!.bindings[key]
    const entity = doc.entities[entityId]
    if (!entity || !hasEntityKind(entity, kind) || entity.archivedAt || entity.placement.parentId !== board.id) {
      throw new Error(`Required automation binding is missing: ${key}`)
    }
    return entityId
  }
  return { boardId: board.id,
    columns: { lead: id("status.lead", "column"), applied: id("status.applied", "column") as string | undefined, interview: id("status.interview", "column"), rejected: id("status.rejected", "column") },
    fieldIds: { company: id("field.company", "field"), role: id("field.role", "field"), jobUrl: id("field.url", "field"),
      notes: id("field.notes", "field"), sourceText: id("field.sourceText", "field") } }
}

async function existingAutomationApproval(existing: WorkspaceDocumentV2["entities"][string], profile: LocalProfile,
  worker: AutomationWorkerIdentity, authorization: AutomationAuthorization, workspaceId: string,
  bindings: ReturnType<typeof selectAutomationBindings>) {
    if (!hasEntityKind(existing, "automation") || existing.executor.personId !== worker.personId || existing.executor.origin !== worker.origin) {
      throw new Error("Automation instance is already bound to another executor")
    }
    if (automationLifecycle(existing).state === "deleted") throw new Error("Deleted automation cannot be reactivated")
    const approval = parseAutomationApproval(existing.approval)
    const owner = { personId: profile.identity.personId, publicKey: authorization.authority.currentOwner.publicKey ?? profile.identity.publicKey,
      certificates: authorization.authority.currentOwner.certificates ?? [profile.certificate] }
    await verifyAutomationDefinition(approval.definition, { workspaceId, boardId: bindings.boardId,
      grantId: approval.grant.payload.grantId, signerKeyId: approval.grant.signerKeyId }, owner)
    const key = approval.grant.signerKeyId === owner.personId ? owner.publicKey
      : owner.certificates.find(value => value.payload.deviceId === approval.grant.signerKeyId)?.payload.devicePublicKey
    if (!key || !(await verifyWorkspaceGrant(approval.grant, key)) || approval.grant.payload.accessEpoch !== authorization.authority.currentEpoch ||
      approval.grant.payload.personId !== worker.personId || canonicalizeJson(approval.grant.payload.automation.columns) !== canonicalizeJson(bindings.columns) ||
      canonicalizeJson([...approval.grant.payload.automation.fieldIds].sort()) !== canonicalizeJson(Object.values(bindings.fieldIds).sort())) {
      throw new Error("Existing automation approval is expired or its scope changed; create a new instance")
    }
    return approval
}
