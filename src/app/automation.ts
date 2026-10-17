import type { AutomationGrantScope } from "../domain/model"
import { canonicalizeJson, publicKeyId, verifyEnvelope, type LocalProfile } from "../domain/identity"
import { automationTypes, parseAutomationDefinition, type AutomationDefinition } from "../domain/automationContract"
import { hasEntityKind, type DeviceCertificate, type WorkspaceDocumentV2 } from "../domain/model"
import { createAutomationWorkspaceGrant, validateCertificateChain, verifyWorkspaceGrant } from "../domain/proofs"
import { encodeBlindBytes } from "../sync/blindEnvelope"
import { automationEntityId, automationLifecycle, isAutomationOrigin } from "../domain/automationLifecycle"
import { parseAutomationApproval } from "../domain/automationApproval"
import { verifyAutomationDefinition } from "../domain/automationDefinitionProof"
import { resolveSigningContext, signWithContext, signingEvidence, type VerifiedSigningContext } from "../domain/signingContext"
import { assertWorkspaceReplicaPurpose } from "../sync/replicaPurpose"

export type AutomationConfiguration = Pick<AutomationDefinition, "name" | "type" | "typeVersion" | "parameters">

export type AutomationWorkerIdentity = {
  integrationId?: string
  definitionId?: string
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

type AutomationActivationInput<A extends AutomationAuthorization, B extends { workspaceId: string }> = {
  profile: LocalProfile; doc: WorkspaceDocumentV2; bytes: Uint8Array; authorization: A;
  blind: B; worker: AutomationWorkerIdentity; expiresAt: number; configuration?: AutomationConfiguration;
  signingContext?: (purpose: string, binding: Record<string, string | number>) => Promise<VerifiedSigningContext>
}

/** Produces private activation data only after local owner approval. */
export async function prepareAutomationActivation<
  A extends AutomationAuthorization,
  B extends { workspaceId: string },
>(input: AutomationActivationInput<A, B>) {
  assertWorkspaceReplicaPurpose(input.blind)
  const live = input
  input = captureActivationInput(input)
  const { profile, doc, authorization, blind, worker } = input
  if (authorization.authority.currentOwner.personId !== profile.identity.personId || blind.workspaceId !== doc.id) {
    throw new Error("Only the verified workspace owner can approve automation")
  }
  await validateWorkerIdentity(profile, worker)
  const bindings = selectAutomationBindings(doc)
  const definitionId = worker.definitionId ?? worker.integrationId ?? worker.personId
  const existing = doc.entities[automationEntityId(definitionId)]
  const expiresAt = input.expiresAt
  const initial = { document: encodeBlindBytes(input.bytes), authorization, chat: null }
  if (existing) {
    if (!hasEntityKind(existing, "automation")) throw new Error("Automation instance ID is occupied")
    const previous = parseAutomationApproval(existing.approval)
    const legacyBindings = { ...bindings, columns: { ...bindings.columns } }
    if (!previous.grant.payload.automation.columns.applied) delete legacyBindings.columns.applied
    const approval = await existingAutomationApproval(existing, profile, worker, authorization, doc.id, legacyBindings, input.bytes, Boolean(input.configuration))
    if (!input.configuration) return { version: 2 as const, workspaceId: doc.id, blind, ...approval, bindings: legacyBindings, initial }

  }
  const { configured, type, parameters, typeVersion } = configuredActivation(input, bindings)
  const contextFor = input.signingContext ?? ((purpose: string, binding: Record<string, string | number>) =>
    resolveSigningContext({ profile, purpose, binding, certificates: authorization.authority.currentOwner.certificates ?? [profile.certificate],
      authorityRevision: canonicalizeJson(authorization.authority), current: async () => ({ personId: live.profile.identity.personId,
        deviceId: live.profile.device.deviceId, authorityRevision: canonicalizeJson(live.authorization.authority) }) }))
  const grantContext = await contextFor("workspace-grant", { workspaceId: doc.id, personId: worker.personId,
    accessEpoch: authorization.authority.currentEpoch })
  initial.authorization = carryActivationSignerEvidence(profile, authorization, grantContext)
  const grant = await createAutomationWorkspaceGrant(profile, doc.id, worker.personId, {
    version: typeVersion, boardId: bindings.boardId, columns: bindings.columns, fieldIds: Object.values(bindings.fieldIds), expiresAt,
  }, authorization.authority.currentEpoch, grantContext)
  const definition: AutomationDefinition = parseAutomationDefinition({
    kind: "automation-definition", version: 1, id: definitionId,
    name: configured?.title ?? type.title, type: type.type, typeVersion: type.version,
    parameters, ...input.configuration, permissions: type.permissions,
    scope: { workspaceId: doc.id, boardId: bindings.boardId, grantId: grant.payload.grantId },
  })
  const definitionContext = await contextFor("automation-definition", { id: definitionId })
  assertActivationSigner(profile, definitionContext)
  return { version: 2 as const, workspaceId: doc.id, blind, grant, bindings, initial,
    definition: await signWithContext(definitionContext, definition) }
}

function configuredActivation<A extends AutomationAuthorization, B extends { workspaceId: string }>(
  input: AutomationActivationInput<A, B>, bindings: ReturnType<typeof selectAutomationBindings>,
) {
  const { doc } = input
  const board = doc.entities[bindings.boardId]
  const configured = hasEntityKind(board, "board") ? board.automation?.types.at(-1) : undefined
  const typeVersion = supportedGrantVersion(input.configuration?.typeVersion ?? configured?.version)
  const type = automationTypes.find(value => value.type === (input.configuration?.type ?? configured?.type) && value.version === typeVersion)
  if (!type) throw new Error("Automation type version is unsupported")
  const parameters = input.configuration?.parameters ?? configured?.defaults ?? type.defaults
  applyBindingConditions(hasEntityKind(board, "board") ? board.automation?.conditions ?? [] : [], bindings, parameters)
  return { configured, type, parameters, typeVersion }
}

function supportedGrantVersion(value: number | undefined): 1 | 2 {
  if (value !== 1 && value !== 2) throw new Error("Unsupported automation grant version")
  return value
}

function applyBindingConditions(conditions: Array<{ group: "columns" | "fieldIds"; key: string; parameter: string; includes: string | number | boolean }>,
  bindings: ReturnType<typeof selectAutomationBindings>, parameters: Record<string, unknown>) {
  for (const condition of conditions) {
    const value = parameters[condition.parameter]
    if (!Array.isArray(value) || !value.includes(condition.includes)) delete (bindings[condition.group] as Record<string, string | undefined>)[condition.key]
  }
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
  const boards = Object.values(doc.entities).filter(entity => hasEntityKind(entity, "board") && !entity.archivedAt)
  if (boards.length !== 1 || !hasEntityKind(boards[0], "board")) throw new Error("Select a workspace with one active board")
  const board = boards[0]
  if (!board.automation) throw new Error("Configure automation bindings on this board")
  const resolve = (refs: Record<string, string>, kind: "column" | "field") => Object.fromEntries(Object.entries(refs).map(([key, id]) => {
    const entity = doc.entities[id]
    if (!entity || !hasEntityKind(entity, kind) || entity.archivedAt || entity.placement.parentId !== board.id) throw new Error(`Required automation binding is missing: ${key}`)
    return [key, id]
  }))
  return { boardId: board.id, columns: resolve(board.automation.bindings.columns, "column") as AutomationGrantScope["columns"],
    fieldIds: resolve(board.automation.bindings.fieldIds, "field") }

}

async function existingAutomationApproval(existing: WorkspaceDocumentV2["entities"][string], profile: LocalProfile,
  worker: AutomationWorkerIdentity, authorization: AutomationAuthorization, workspaceId: string,
  bindings: ReturnType<typeof selectAutomationBindings>, bytes: Uint8Array, renewal = false) {
    if (!hasEntityKind(existing, "automation") || existing.executor.personId !== worker.personId || existing.executor.origin !== worker.origin) {
      throw new Error("Automation instance is already bound to another executor")
    }
    if (automationLifecycle(existing).state === "deleted") throw new Error("Deleted automation cannot be reactivated")
    const approval = parseAutomationApproval(existing.approval)
    const epochChanged = approval.grant.payload.accessEpoch !== authorization.authority.currentEpoch
    if (epochChanged && !renewal) throw new Error("Workspace owner authority changed; review and renew this automation approval")
    const owner = await existingApprovalIssuer(profile, authorization, workspaceId, bytes,
      approval.grant.payload.accessEpoch, renewal)
    await verifyAutomationDefinition(approval.definition, { workspaceId, boardId: bindings.boardId,
      grantId: approval.grant.payload.grantId, signerKeyId: approval.grant.signerKeyId }, owner)
    const validGrant = await verifyExistingGrant(approval, owner, renewal)
    if (!validGrant ||
      approval.grant.payload.personId !== worker.personId || canonicalizeJson(approval.grant.payload.automation.columns) !== canonicalizeJson(bindings.columns) ||
      canonicalizeJson([...approval.grant.payload.automation.fieldIds].sort()) !== canonicalizeJson(Object.values(bindings.fieldIds).sort())) {
      throw new Error("Existing automation approval is expired or its scope changed; review and renew this instance")
    }
    return approval
}

async function existingApprovalIssuer(profile: LocalProfile, authorization: AutomationAuthorization,
  workspaceId: string, bytes: Uint8Array, epoch: number, renewal: boolean) {
  if (!renewal || epoch === authorization.authority.currentEpoch && !("genesisOwner" in authorization.authority)) {
    return { personId: profile.identity.personId, publicKey: authorization.authority.currentOwner.publicKey ?? profile.identity.publicKey,
      certificates: authorization.authority.currentOwner.certificates ?? [profile.certificate] }
  }
  const { admitHistoricalAutomationAuthority } = await import("../sync/historicalAutomationAuthority")
  const history = admitHistoricalAutomationAuthority({ workspaceId, epoch, bytes, authorization })
  history.requireCurrentOwner({ personId: profile.identity.personId, publicKey: profile.identity.publicKey,
    certificates: [profile.certificate, ...history.authority.currentOwner.certificates] }, profile.device.deviceId)
  return history.issuer
}

async function verifyExistingGrant(approval: ReturnType<typeof parseAutomationApproval>,
  owner: { personId: string; publicKey: string; certificates: DeviceCertificate[] }, renewal: boolean): Promise<boolean> {
  const key = approval.grant.signerKeyId === owner.personId ? owner.publicKey
    : owner.certificates.find(value => value.payload.deviceId === approval.grant.signerKeyId)?.payload.devicePublicKey
  if (!key) return false
  // Expired proof establishes the previous contract, never present execution rights.
  return renewal ? verifyEnvelope(approval.grant, key) : verifyWorkspaceGrant(approval.grant, key)
}

function captureActivationInput<A extends AutomationAuthorization, B extends { workspaceId: string }>(input: AutomationActivationInput<A, B>): AutomationActivationInput<A, B> {
  return { ...input, profile: { ...input.profile, identity: structuredClone(input.profile.identity),
    device: structuredClone(input.profile.device), certificate: structuredClone(input.profile.certificate), privateKeys: { ...input.profile.privateKeys } },
    doc: JSON.parse(JSON.stringify(input.doc)) as WorkspaceDocumentV2, bytes: input.bytes.slice(),
    authorization: structuredClone(input.authorization), blind: structuredClone(input.blind), worker: structuredClone(input.worker),
    ...(input.configuration ? { configuration: structuredClone(input.configuration) } : {}) }
}

function assertActivationSigner(profile: LocalProfile, context: VerifiedSigningContext) {
  if (context.personId !== profile.identity.personId || context.deviceId !== profile.device.deviceId) {
    throw new Error("Activation signing context belongs to another owner device")
  }
}
function carryActivationSignerEvidence<A extends AutomationAuthorization>(profile: LocalProfile, authorization: A,
  context: VerifiedSigningContext): A {
  assertActivationSigner(profile, context)
  const evidence = signingEvidence(context)
  const certificates = new Map([...(authorization.authority.currentOwner.certificates ?? []), ...evidence.certificates]
    .map(certificate => [canonicalizeJson(certificate), certificate]))
  return { ...authorization, authority: { ...authorization.authority, currentOwner: { ...authorization.authority.currentOwner,
    publicKey: evidence.identity.publicKey, certificates: [...certificates.values()] } } }
}
