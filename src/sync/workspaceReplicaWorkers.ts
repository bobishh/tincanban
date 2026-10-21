import { canonicalizeJson } from "../domain/identity"
import { parseAutomationApproval } from "../domain/automationApproval"
import { parseAutomationDefinition, type AutomationDefinition } from "../domain/automationContract"
import { automationLifecycle } from "../domain/automationLifecycle"
import { hasEntityKind, type DeviceCertificate, type WorkspaceDocumentV2, type WorkspaceEntity, type WorkspaceGrant } from "../domain/model"
import type { LocalProfile } from "../domain/identity"
import { meshRustRuntime } from "@meta-uber/mesh-replication/runtime"
import type { WorkspaceRevocation } from "./meshRecords"
import type { AutomationInstanceDescription } from "../domain/automationInstanceData"
import type { readAutomationInstance, refreshAutomationStorageAccess } from "../app/automationInstanceClient"
import { parseRustyScopePolicyReceipt, type RustyScopePolicyReceipt } from "../product-replica"
import type { BlindReplicaConfig } from "./blindReplication"
import { parseReplicaWriterWorkers, type ReplicaWriterWorker } from "./replicaWriterWorkersState"
import { withAutomationWriterDependency } from "./replicaDependencyError"

export type { ReplicaWriterWorker } from "./replicaWriterWorkersState"

type WorkspacePick = {
  readWorkspaceDoc: (workspaceId: string) => WorkspaceDocumentV2 | undefined | Promise<WorkspaceDocumentV2 | undefined>
  getCurrentProfile: () => LocalProfile | null | undefined
}
type GuardAsync = () => void | Promise<void>

/** Find typed automation routes whose currently authenticated Worker uses this exact Rusty scope. */
export async function discoverWorkspaceReplicaWorkers(appPick: WorkspacePick, configValue: BlindReplicaConfig,
  guardAsync: GuardAsync, acceptedStorageVariants?: readonly BlindReplicaConfig[]): Promise<ReplicaWriterWorker[]> {
  const config = structuredClone(configValue)
  const accepted = acceptedStorageVariants ? structuredClone([...acceptedStorageVariants]) : [config]
  const profileValue = appPick.getCurrentProfile()
  if (!profileValue) throw new Error("Current identity is unavailable for Worker discovery")
  const profile = structuredClone(profileValue)
  await guardAsync()
  const documentValue = await appPick.readWorkspaceDoc(config.workspaceId)
  const documentId = documentValue?.id
  const routeInfos: AutomationRouteInfo[] = []
  if (documentValue && documentId === config.workspaceId) {
    // Automerge documents are proxy-backed. Capture only immutable route data
    // synchronously before the next await; cloning the document can fail and
    // needlessly walks private board contents.
    for (const entity of Object.values(documentValue.entities)) {
      if (!hasEntityKind(entity, "automation")) continue
      automationLifecycle(entity)
      routeInfos.push(readTypedAutomationRoute(entity, documentId))
    }
  }
  await guardAsync()
  if (!documentValue || documentId !== config.workspaceId) throw new Error("Current workspace changed during Worker discovery")

  const routesInfo = new Set<string>()
  const executorIds = new Set<string>()
  const routes: ReplicaWriterWorker[] = []
  for (const routeInfo of routeInfos) {
    routesInfo.add(routeInfo.grantId)
    executorIds.add(routeInfo.executorPersonId)
    const route = await inspectAutomationRoute(profile, routeInfo, documentId, config, guardAsync, accepted)
    if (route) routes.push(route)
    if (routes.length > 64) throw new Error("Automation Worker refresh cohort exceeds its limit")
  }

  await rejectUnroutedAutomationGrants(documentId, routesInfo, executorIds, guardAsync)

  const parsed = parseReplicaWriterWorkers(routes, documentId)
  const candidateOrigins = [...new Set(parsed.map(route => route.origin))]
  const { assertAutomationStorageRefreshSupported } = await import("../app/automationInstanceClient")
  for (const origin of candidateOrigins) {
    await guardAsync()
    await withAutomationWriterDependency("inspection", origin, () => assertAutomationStorageRefreshSupported(origin))
    await guardAsync()
  }
  return parsed
}

/** Apply an already verified Rusty receipt to each captured Worker route without renewing grants. */
export async function refreshWorkspaceReplicaWorkers(profileValue: LocalProfile, configValue: BlindReplicaConfig,
  receiptValue: RustyScopePolicyReceipt, targetValues: ReplicaWriterWorker[], guardAsync: GuardAsync): Promise<void> {
  const profile = structuredClone(profileValue)
  const config = structuredClone(configValue)
  const targets = parseReplicaWriterWorkers(structuredClone(targetValues), config.workspaceId)
  const receipt = parseRustyScopePolicyReceipt(receiptValue)
  if (receipt.payload.scopeId !== config.scopeId || receipt.payload.personId !== profile.identity.personId ||
      receipt.payload.revoked || receipt.payload.minimumWriterVersion !== 2) {
    throw new Error("Rusty policy receipt does not authorize this Worker refresh cohort")
  }
  const { readAutomationInstance, refreshAutomationStorageAccess } = await import("../app/automationInstanceClient")
  for (const target of targets) {
    await refreshOneWorker(profile, config, receipt, target, readAutomationInstance, refreshAutomationStorageAccess, guardAsync)
  }
}

type AutomationRouteInfo = { origin: string; definition: AutomationDefinition; executorPersonId: string; grantId: string }
function readTypedAutomationRoute(entity: Extract<WorkspaceEntity, { kind: "automation" }>, workspaceId: string): AutomationRouteInfo {
  const definition = parseAutomationDefinition(JSON.parse(entity.definition))
  const approval = parseAutomationApproval(entity.approval)
  if (definition.scope.workspaceId !== workspaceId || definition.scope.workspaceId !== approval.grant.payload.workspaceId ||
      definition.scope.boardId !== approval.grant.payload.automation.boardId ||
      definition.scope.grantId !== approval.grant.payload.grantId || definition.id !== approval.definition.payload.id ||
      canonicalizeJson(definition) !== canonicalizeJson(approval.definition.payload) ||
      entity.executor.personId !== approval.grant.payload.personId || entity.placement.parentId !== definition.scope.boardId) {
    throw new Error("Automation definition, executor and signed approval do not agree")
  }
  return { origin: entity.executor.origin, definition, executorPersonId: entity.executor.personId, grantId: approval.grant.payload.grantId }
}

async function inspectAutomationRoute(profile: LocalProfile, route: AutomationRouteInfo, workspaceId: string,
  config: BlindReplicaConfig, guard: GuardAsync, accepted: readonly BlindReplicaConfig[]): Promise<ReplicaWriterWorker | undefined> {
  const { inspectExistingAutomation } = await import("../app/automationInstanceManagement")
  const inspected = await withAutomationWriterDependency("inspection", route.origin, () => inspectExistingAutomation(profile,
    { origin: route.origin, workspaceId, definitionId: route.definition.id, executorPersonId: route.executorPersonId },
    { ensureCurrent: guard }))
  await guard()
  const identity = inspected.identity
  if (identity.origin !== route.origin || inspected.description.workspaceId !== workspaceId ||
      identity.definitionId !== route.definition.id || identity.personId !== route.executorPersonId || !identity.integrationId) {
    throw new Error("Automation instance identity does not match its signed workspace route")
  }
  const storage = inspected.description.storage
  if (!storage) throw new Error("Automation instance does not expose its authenticated Rusty storage pin")
  if (storage.origin !== config.origin || storage.scopeId !== config.scopeId) return undefined
  assertWorkerStorageVersion(storage, config, accepted)
  return { origin: identity.origin, workspaceId, definitionId: route.definition.id,
    executorPersonId: identity.personId, integrationId: identity.integrationId }
}

function assertWorkerStorageVersion(storage: NonNullable<AutomationInstanceDescription["storage"]>, config: BlindReplicaConfig,
  accepted: readonly BlindReplicaConfig[]) {
  const candidates = accepted.filter(candidate => candidate.workspaceId === config.workspaceId &&
    candidate.origin === config.origin && candidate.scopeId === config.scopeId)
  if (candidates.some(candidate => storage.keyEpoch === candidate.keyEpoch && storage.servicePublicKey === candidate.servicePublicKey)) return
  const sameService = candidates.filter(candidate => candidate.servicePublicKey === storage.servicePublicKey)
  if (!sameService.length) throw new Error("Automation is connected to a different Rusty service identity. Verify its server before retrying.")
  const epochs = [...new Set(sameService.map(candidate => candidate.keyEpoch))].sort((left, right) => left - right)
  throw new Error(`Automation uses Rusty key epoch ${storage.keyEpoch}; this connection expects ${epochs.join(" or ")}. Update automation storage access before retrying.`)
}

async function rejectUnroutedAutomationGrants(workspaceId: string, typedGrantIds: Set<string>, executorIds: Set<string>, guard: GuardAsync) {
  // Missing route can never be silently refreshed.
  const { defaultProofStore } = await import("../domain/proofs")
  const grants = await defaultProofStore.listGrants(workspaceId)
  await guard()
  const unknown = grants.filter(grant => grant.payload.role === "automation" && grant.payload.automation &&
    grant.payload.automation.expiresAt > Date.now() && !typedGrantIds.has(grant.payload.grantId) && !executorIds.has(grant.payload.personId))
  if (!unknown.length) return
  const revokedGrantIds = await verifiedRevokedGrantIds(workspaceId, unknown, guard)
  for (const grant of unknown) {
    if (!revokedGrantIds.has(grant.payload.grantId)) {
      throw new Error("An existing unexpired automation grant has no typed Worker route; adopt or remove that Worker before refreshing Rusty storage")
    }
  }
}

async function verifiedRevokedGrantIds(workspaceId: string, grants: WorkspaceGrant[], guard: GuardAsync): Promise<Set<string>> {
  const { readWorkspaceSigningAuthority } = await import("./changeAuthorization")
  const stored = await readWorkspaceSigningAuthority(workspaceId)
  await guard()
  if (stored.invalid) throw new Error("Workspace authority cannot confirm cached automation grant revocation")
  if (!stored.authority) return new Set()
  const authority = stored.authority as { ownerPersonId?: unknown; ownerPublicKey?: unknown; ownerCertificates?: unknown; catalog?: unknown }
  if (typeof authority.ownerPersonId !== "string" || typeof authority.ownerPublicKey !== "string" ||
      !Array.isArray(authority.ownerCertificates)) throw new Error("Workspace authority cannot verify cached automation grant revocation")
  const revocations = authorityRevocations(authority.catalog)
  if (!revocations.length) return new Set()
  const signer = { personId: authority.ownerPersonId, publicKey: authority.ownerPublicKey,
    certificates: authority.ownerCertificates as DeviceCertificate[] }
  const verified = revocations.map(raw => meshRustRuntime().state.verifyWorkspaceRevocation(raw,
    workspaceId, signer, Date.now()) as WorkspaceRevocation)
  await guard()
  const revoked = new Set<string>()
  for (const grant of grants) {
    const epoch = grant.payload.accessEpoch ?? 1
    if (verified.some(record => record.payload.personId === grant.payload.personId && record.payload.epoch >= epoch)) {
      revoked.add(grant.payload.grantId)
    }
  }
  return revoked
}

function authorityRevocations(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Workspace authority catalog is invalid")
  const revocations = (value as { revocations?: unknown }).revocations
  if (revocations === undefined) return []
  if (!Array.isArray(revocations) || revocations.length > 4096) throw new Error("Workspace revocation history is invalid or too large")
  return revocations
}

async function refreshOneWorker(profile: LocalProfile, config: BlindReplicaConfig, receipt: RustyScopePolicyReceipt,
  target: ReplicaWriterWorker, read: typeof readAutomationInstance,
  refresh: typeof refreshAutomationStorageAccess, guard: GuardAsync): Promise<void> {
  await guard()
  const route = { origin: target.origin, workspaceId: target.workspaceId, definitionId: target.definitionId,
    executorPersonId: target.executorPersonId, integrationId: target.integrationId }
  const before = await withAutomationWriterDependency("inspection", target.origin, () => read(profile, route, { ensureCurrent: guard }))
  await guard()
  assertIdentityRoute(before.identity, target)
  const prior = before.identity.description
  const pin = storagePin(prior.storage, config)
  const after = await withAutomationWriterDependency("confirmation", target.origin,
    () => refresh(profile, { ...route, storage: pin, receipt }, { ensureCurrent: guard }))
  await guard()
  assertIdentityRoute(after.identity, target)
  assertRefreshPreservedAutomation(prior, after.identity.description, receipt)
}

function storagePin(storage: AutomationInstanceDescription["storage"], config: BlindReplicaConfig) {
  if (!storage || storage.origin !== config.origin || storage.scopeId !== config.scopeId || storage.keyEpoch !== config.keyEpoch ||
      storage.servicePublicKey !== config.servicePublicKey) throw new Error("Automation instance Rusty storage pin changed before refresh")
  return { origin: storage.origin, scopeId: storage.scopeId, keyEpoch: storage.keyEpoch, servicePublicKey: storage.servicePublicKey }
}

function assertRefreshPreservedAutomation(before: AutomationInstanceDescription, after: AutomationInstanceDescription,
  receipt: RustyScopePolicyReceipt): void {
  const storage = after.storage
  if (after.grantId !== before.grantId || after.expiresAt !== before.expiresAt || after.state !== before.state || !storage ||
      storage.origin !== before.storage?.origin || storage.scopeId !== before.storage?.scopeId ||
      storage.keyEpoch !== before.storage?.keyEpoch || storage.servicePublicKey !== before.storage?.servicePublicKey ||
      storage.policyRevision !== receipt.payload.revision || storage.minimumWriterVersion !== 2) {
    throw new Error("Worker refresh changed its grant or failed to confirm the exact Rusty policy")
  }
}

function assertIdentityRoute(identity: { origin: string; workspaceId: string; definitionId: string; integrationId: string;
  executorPersonId: string }, target: ReplicaWriterWorker): void {
  if (identity.origin !== target.origin || identity.workspaceId !== target.workspaceId ||
      identity.definitionId !== target.definitionId || identity.executorPersonId !== target.executorPersonId ||
      identity.integrationId !== target.integrationId) throw new Error("Automation Worker route changed during Rusty refresh")
}
