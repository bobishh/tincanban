import { z } from "zod"
import { requestWorkerJson } from "./workerJsonResponse"
import { automationBodyHash } from "../domain/automationProtocol"
import { canonicalizeJson } from "../domain/identity"
import { isAutomationOrigin } from "../domain/automationLifecycle"
import { parseAutomationInstanceBody, parseAutomationInstanceDiscovery,
  type AutomationInstancePrepareHistoryBody, type AutomationInstanceActivateHistoryBody, type AutomationInstanceRefreshBody, type AutomationInstancePrepareRotationBody, type AutomationInstanceRotateStorageBody } from "../domain/automationInstanceData"
import { verifyAutomationInstanceIdentity,
  type AutomationInstanceIdentityPayload, type AutomationInstanceIdentityProof } from "../domain/automationInstanceIdentity"
import { createAutomationInstanceRequest, type AutomationInstanceAction } from "../domain/automationInstanceProtocol"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import type { LocalProfile } from "../domain/identity"
import { verifyRustyWriterPolicyReceipt } from "../product-replica"

const maxResponseBytes = 384 * 1024
const actionSchema = z.enum(["discover", "identity", "activate", "refresh-access", "prepare-storage-rotation", "rotate-storage", "prepare-history-baseline", "activate-history-baseline"])
const actionsSchema = z.array(actionSchema).max(32).refine(values => new Set(values).size === values.length)
const instanceManagementSchema = z.strictObject({ version: z.number().int().positive().optional(), actions: actionsSchema.optional() })
const receiptSchema = z.strictObject({ status: z.enum(["active", "paused", "deleted"]), synced: z.literal(true) })

export class UnsupportedAutomationInstanceManagementError extends Error {
  constructor() {
    super("Worker does not support automation instance management version 1")
    this.name = "UnsupportedAutomationInstanceManagementError"
  }
}

export type AutomationInstanceClientGuards = {
  currentAuthority?: () => Promise<string>
  ensureCurrent?: () => void | Promise<void>
}
export type AutomationInstanceDiscoveryInput = { origin: string; workspaceId: string; definitionId: string; executorPersonId: string }
export type AutomationInstanceReadInput = AutomationInstanceDiscoveryInput & { integrationId: string }
export type AutomationInstanceActivationInput = AutomationInstanceReadInput & { packet: unknown; adoptLegacy: boolean }
export type AutomationInstanceStorageRefreshInput = AutomationInstanceReadInput & Pick<AutomationInstanceRefreshBody, "storage" | "receipt">
export type AutomationInstancePrepareRotationInput = AutomationInstanceReadInput & Pick<AutomationInstancePrepareRotationBody, "storage" | "transitionId">
export type AutomationInstanceRotateStorageInput = AutomationInstanceReadInput & Pick<AutomationInstanceRotateStorageBody, "storage" | "transitionId" | "credentials" | "receipt">
export type AutomationInstancePrepareHistoryInput = AutomationInstanceReadInput & Pick<AutomationInstancePrepareHistoryBody, "storage" | "transitionId" | "scopeAuthoritySnapshot">
export type AutomationInstanceActivateHistoryInput = AutomationInstanceReadInput & Pick<AutomationInstanceActivateHistoryBody, "storage" | "transitionId" | "baselineId">
type ActionBody = { workspaceId: string; definitionId: string; executorPersonId: string; integrationId?: string;
  packet?: unknown; adoptLegacy?: boolean }

/** Discover exactly one integration route already bound to the requested executor identity. */
export async function discoverAutomationInstance(profile: LocalProfile, inputValue: AutomationInstanceDiscoveryInput,
  guards?: AutomationInstanceClientGuards): Promise<{ integrationId: string }> {
  const profileSnapshot = structuredClone(profile)
  const input = structuredClone(inputValue)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  const body = parseAutomationInstanceBody("discover", scopeBody(input))
  const { value } = await send(profileSnapshot, input, "discover", body, options)
  const discovery = parseAutomationInstanceDiscovery(value, { origin: input.origin, workspaceId: input.workspaceId,
    definitionId: input.definitionId, executorPersonId: input.executorPersonId })
  if (discovery.integrations.length !== 1) throw new Error("Automation instance discovery did not identify exactly one route")
  return { integrationId: discovery.integrations[0]!.integrationId }
}

/** Read and authenticate one current instance description from its pinned executor device. */
export async function readAutomationInstance(profile: LocalProfile, inputValue: AutomationInstanceReadInput,
  guards?: AutomationInstanceClientGuards): Promise<{ proof: AutomationInstanceIdentityProof; identity: AutomationInstanceIdentityPayload }> {
  const profileSnapshot = structuredClone(profile)
  const input = structuredClone(inputValue)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  const body = parseAutomationInstanceBody("identity", { ...scopeBody(input), integrationId: input.integrationId })
  const { value, request } = await send(profileSnapshot, input, "identity", body, options)
  const proof = value as AutomationInstanceIdentityProof
  const identity = await verifyAutomationInstanceIdentity(proof, { origin: input.origin, workspaceId: input.workspaceId,
    definitionId: input.definitionId, integrationId: input.integrationId, executorPersonId: input.executorPersonId,
    requestNonce: request.signed.payload.nonce })
  await options?.ensureCurrent?.()
  return { proof, identity }
}

/** Preflight the dedicated policy-only refresh capability without sending a mutation. */
export async function assertAutomationStorageRefreshSupported(origin: string): Promise<void> {
  assertOrigin(origin)
  await assertSupported(origin, "refresh-access")
}

/** Both phases must be available before changing any server token. */
export async function assertAutomationStorageRotationSupported(origin: string): Promise<void> {
  assertOrigin(origin)
  await assertSupported(origin, "prepare-storage-rotation")
  await assertSupported(origin, "rotate-storage")
}

/** Require both maintenance phases and the complete compact-history reader before freezing any executor. */
export async function assertAutomationHistoryBaselineSupported(origin: string): Promise<void> {
  assertOrigin(origin)
  await assertSupported(origin, "prepare-history-baseline")
  await assertSupported(origin, "activate-history-baseline")
  const value = await requestJson(origin, "/v2/capabilities", "GET")
  if (!isRecord(value) || value.origin !== origin || !isRecord(value.readers) ||
    !Number.isSafeInteger(value.readers.automationState) || (value.readers.automationState as number) < 5 ||
    !Number.isSafeInteger(value.readers.workspaceSnapshot) || (value.readers.workspaceSnapshot as number) < 2) {
    throw new Error("Worker cannot verify compact workspace history")
  }
}

export async function prepareAutomationHistoryBaseline(profile: LocalProfile, inputValue: AutomationInstancePrepareHistoryInput,
  guards?: AutomationInstanceClientGuards): Promise<{ proof: AutomationInstanceIdentityProof; identity: AutomationInstanceIdentityPayload }> {
  const input = structuredClone(inputValue), profileSnapshot = structuredClone(profile), options = guards ? { ...guards } : undefined
  await assertAutomationHistoryBaselineSupported(input.origin)
  const body = parseAutomationInstanceBody("prepare-history-baseline", { ...scopeBody(input), integrationId: input.integrationId,
    storage: input.storage, transitionId: input.transitionId, scopeAuthoritySnapshot: input.scopeAuthoritySnapshot })
  const result = await sendHistoryPhase(profileSnapshot, input, "prepare-history-baseline", body, options)
  const transition = result.identity.description.historyTransition
  if (!transition || transition.transitionId !== input.transitionId || transition.state !== "frozen") {
    throw new Error("Worker did not confirm its exact durable history freeze")
  }
  return result
}

export async function activateAutomationHistoryBaseline(profile: LocalProfile, inputValue: AutomationInstanceActivateHistoryInput,
  guards?: AutomationInstanceClientGuards): Promise<{ proof: AutomationInstanceIdentityProof; identity: AutomationInstanceIdentityPayload }> {
  const input = structuredClone(inputValue), profileSnapshot = structuredClone(profile), options = guards ? { ...guards } : undefined
  await assertAutomationHistoryBaselineSupported(input.origin)
  const body = parseAutomationInstanceBody("activate-history-baseline", { ...scopeBody(input), integrationId: input.integrationId,
    storage: input.storage, transitionId: input.transitionId, baselineId: input.baselineId })
  const result = await sendHistoryPhase(profileSnapshot, input, "activate-history-baseline", body, options)
  if (result.identity.description.historyTransition || result.identity.description.historyBaselineId !== input.baselineId) {
    throw new Error("Worker did not confirm the exact activated history baseline")
  }
  return result
}

async function sendHistoryPhase(profile: LocalProfile, input: AutomationInstancePrepareHistoryInput | AutomationInstanceActivateHistoryInput,
  action: "prepare-history-baseline" | "activate-history-baseline", body: AutomationInstancePrepareHistoryBody | AutomationInstanceActivateHistoryBody,
  guards?: AutomationInstanceClientGuards) {
  const { value, request } = await send(profile, input, action, body, guards)
  const proof = value as AutomationInstanceIdentityProof
  const identity = await verifyAutomationInstanceIdentity(proof, { origin: input.origin, workspaceId: input.workspaceId,
    definitionId: input.definitionId, integrationId: input.integrationId, executorPersonId: input.executorPersonId,
    requestNonce: request.signed.payload.nonce })
  const storage = identity.description.storage
  if (!storage || canonicalizeJson({ origin: storage.origin, scopeId: storage.scopeId, keyEpoch: storage.keyEpoch,
    servicePublicKey: storage.servicePublicKey }) !== canonicalizeJson(input.storage)) throw new Error("Worker history phase changed pinned storage")
  await guards?.ensureCurrent?.()
  return { proof, identity }
}

/** Refuse to export ambiguous historical keys to Workers that cannot read every retained key variant. */
export async function assertAutomationKeyHistorySupported(origin: string): Promise<void> {
  assertOrigin(origin)
  const value = await requestJson(origin, "/v2/capabilities", "GET")
  if (!isRecord(value) || value.origin !== origin || value.version !== 2 || !isRecord(value.readers) ||
    !Number.isSafeInteger(value.readers.automationState) || (value.readers.automationState as number) < 4) {
    throw new Error("Worker does not support multi-key replica history")
  }
}

/** Drain exact saved work and obtain a signed, durable executor freeze without renewing its grant. */
export async function prepareAutomationStorageRotation(profile: LocalProfile, inputValue: AutomationInstancePrepareRotationInput,
  guards?: AutomationInstanceClientGuards): Promise<{ proof: AutomationInstanceIdentityProof; identity: AutomationInstanceIdentityPayload }> {
  const input = structuredClone(inputValue), profileSnapshot = structuredClone(profile)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  await assertAutomationStorageRotationSupported(input.origin)
  const body = parseAutomationInstanceBody("prepare-storage-rotation", { ...scopeBody(input), integrationId: input.integrationId,
    storage: input.storage, transitionId: input.transitionId })
  const { value, request } = await send(profileSnapshot, input, "prepare-storage-rotation", body, options)
  const proof = value as AutomationInstanceIdentityProof
  const identity = await verifyAutomationInstanceIdentity(proof, { origin: input.origin, workspaceId: input.workspaceId,
    definitionId: input.definitionId, integrationId: input.integrationId, executorPersonId: input.executorPersonId,
    requestNonce: request.signed.payload.nonce })
  const storage = identity.description.storage
  if (!storage || canonicalizeJson({ origin: storage.origin, scopeId: storage.scopeId, keyEpoch: storage.keyEpoch,
    servicePublicKey: storage.servicePublicKey }) !== canonicalizeJson(input.storage) ||
    identity.description.storageTransition?.transitionId !== input.transitionId || identity.description.storageTransition.state !== "frozen") {
    throw new Error("Worker did not confirm the exact durable storage freeze")
  }
  await options?.ensureCurrent?.()
  return { proof, identity }
}

/** Install confirmed future keys on the original executor; the signed result contains only public storage coordinates. */
export async function rotateAutomationStorageCredentials(profile: LocalProfile, inputValue: AutomationInstanceRotateStorageInput,
  guards?: AutomationInstanceClientGuards): Promise<{ proof: AutomationInstanceIdentityProof; identity: AutomationInstanceIdentityPayload }> {
  const input = structuredClone(inputValue), profileSnapshot = structuredClone(profile)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  if (input.credentials.historicalContentKeyVariants) await assertAutomationKeyHistorySupported(input.origin)
  const receipt = await verifyRustyWriterPolicyReceipt(input.receipt, input.credentials, profileSnapshot.identity.personId,
    input.credentials.policyRevision)
  if (receipt.payload.revision !== input.credentials.policyRevision) throw new Error("Rusty rotation receipt differs from target policy")
  const body = parseAutomationInstanceBody("rotate-storage", { ...scopeBody(input), integrationId: input.integrationId,
    storage: input.storage, transitionId: input.transitionId, credentials: input.credentials, receipt })
  const { value, request } = await send(profileSnapshot, input, "rotate-storage", body, options)
  const proof = value as AutomationInstanceIdentityProof
  const identity = await verifyAutomationInstanceIdentity(proof, { origin: input.origin, workspaceId: input.workspaceId,
    definitionId: input.definitionId, integrationId: input.integrationId, executorPersonId: input.executorPersonId,
    requestNonce: request.signed.payload.nonce })
  const expected = { origin: input.credentials.origin, scopeId: input.credentials.scopeId, keyEpoch: input.credentials.keyEpoch,
    servicePublicKey: input.credentials.servicePublicKey, policyRevision: input.credentials.policyRevision, minimumWriterVersion: 2 }
  if (identity.description.storageTransition || canonicalizeJson(identity.description.storage) !== canonicalizeJson(expected)) {
    throw new Error("Worker did not confirm the exact activated Rusty credentials")
  }
  await options?.ensureCurrent?.()
  return { proof, identity }
}

/** Refresh only a Worker replica's pinned Rusty policy revision; grant authorization is unchanged. */
export async function refreshAutomationStorageAccess(profile: LocalProfile, inputValue: AutomationInstanceStorageRefreshInput,
  guards?: AutomationInstanceClientGuards): Promise<{ proof: AutomationInstanceIdentityProof; identity: AutomationInstanceIdentityPayload }> {
  const profileSnapshot = structuredClone(profile)
  const input = structuredClone(inputValue)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  await options?.ensureCurrent?.()
  const receipt = await verifyRustyWriterPolicyReceipt(input.receipt, input.storage,
    profileSnapshot.identity.personId, 1)
  await options?.ensureCurrent?.()
  const body = parseAutomationInstanceBody("refresh-access", { ...scopeBody(input), integrationId: input.integrationId,
    storage: input.storage, receipt })
  const { value, request } = await send(profileSnapshot, input, "refresh-access", body, options)
  const proof = value as AutomationInstanceIdentityProof
  const identity = await verifyAutomationInstanceIdentity(proof, { origin: input.origin, workspaceId: input.workspaceId,
    definitionId: input.definitionId, integrationId: input.integrationId, executorPersonId: input.executorPersonId,
    requestNonce: request.signed.payload.nonce })
  if (receipt.payload.scopeId !== input.storage.scopeId || receipt.payload.personId !== profileSnapshot.identity.personId ||
    receipt.payload.revoked || receipt.payload.minimumWriterVersion !== 2) {
    throw new Error("Rusty policy receipt does not confirm this Worker storage refresh")
  }
  const expectedStorage = { ...input.storage, policyRevision: receipt.payload.revision, minimumWriterVersion: 2 }
  if (!identity.description.storage || canonicalizeJson(identity.description.storage) !== canonicalizeJson(expectedStorage)) {
    throw new Error("Worker identity does not confirm the exact Rusty policy revision")
  }
  await options?.ensureCurrent?.()
  return { proof, identity }
}

/** Send a complete owner-approved replacement or explicit legacy adoption packet. */
export async function activateExistingAutomation(profile: LocalProfile, inputValue: AutomationInstanceActivationInput,
  guards?: AutomationInstanceClientGuards): Promise<void> {
  const profileSnapshot = structuredClone(profile)
  const input = structuredClone(inputValue)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  const body = parseAutomationInstanceBody("activate", { ...scopeBody(input), integrationId: input.integrationId,
    packet: input.packet, adoptLegacy: input.adoptLegacy })
  const { value } = await send(profileSnapshot, input, "activate", body, options)
  receiptSchema.parse(value)
  await options?.ensureCurrent?.()
}

async function send(profile: LocalProfile, input: AutomationInstanceDiscoveryInput, action: AutomationInstanceAction,
  body: unknown, guards?: AutomationInstanceClientGuards): Promise<{ value: unknown; request: Awaited<ReturnType<typeof signRequest>> }> {
  await guards?.ensureCurrent?.()
  await assertSupported(input.origin, action)
  const request = await signRequest(profile, input, action, body, guards)
  await guards?.ensureCurrent?.()
  const value = await requestJson(input.origin, `/v2/automation-instances/${action}`, "POST", { instanceRequest: request, body })
  await guards?.ensureCurrent?.()
  return { value, request }
}

async function assertSupported(origin: string, action: AutomationInstanceAction): Promise<void> {
  const value = await requestJson(origin, "/v2/capabilities", "GET")
  if (!isRecord(value) || value.origin !== origin) throw new Error("Worker capability origin does not match its address")
  if (value.version !== 2) throw new UnsupportedAutomationInstanceManagementError()
  if (!Object.hasOwn(value, "instanceManagement")) throw new UnsupportedAutomationInstanceManagementError()
  const raw = value.instanceManagement
  if (!isRecord(raw)) throw new Error("Worker instance-management capability is invalid")
  const parsed = instanceManagementSchema.parse(raw)
  if (parsed.version === undefined || parsed.version !== 1 || parsed.actions === undefined) {
    throw new UnsupportedAutomationInstanceManagementError()
  }
  if (!parsed.actions.includes(action)) throw new UnsupportedAutomationInstanceManagementError()
}

async function signRequest(profile: LocalProfile, input: AutomationInstanceDiscoveryInput,
  action: AutomationInstanceAction, body: unknown, guards?: AutomationInstanceClientGuards) {
  const integrationId = isRecord(body) && typeof body.integrationId === "string" ? body.integrationId : null
  const bodyHash = await automationBodyHash(body)
  const binding: Record<string, string | number> = { action, origin: input.origin, workspaceId: input.workspaceId,
    definitionId: input.definitionId, executorPersonId: input.executorPersonId, bodyHash,
    ...(integrationId ? { integrationId } : {}) }
  const context = await resolveLocalSigningContext(profile, "automation-instance-request", binding,
    { ...(guards ?? {}), expiresAt: Date.now() + 60_000 })
  return createAutomationInstanceRequest(context, { action, origin: binding.origin as string,
    workspaceId: binding.workspaceId as string, definitionId: binding.definitionId as string,
    integrationId, executorPersonId: binding.executorPersonId as string, bodyHash })
}

async function requestJson(origin: string, path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
  return requestWorkerJson(origin, path, method, maxResponseBytes, body)
}

function assertOrigin(origin: string): void {
  if (!isAutomationOrigin(origin)) throw new TypeError("Worker address must be an HTTPS origin")
}

function scopeBody(input: AutomationInstanceDiscoveryInput): ActionBody {
  return { workspaceId: input.workspaceId, definitionId: input.definitionId, executorPersonId: input.executorPersonId }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
