import { z } from "zod"
import { requestWorkerJson } from "./workerJsonResponse"
import { automationBodyHash } from "../domain/automationProtocol"
import { canonicalizeJson } from "../domain/identity"
import { isAutomationOrigin } from "../domain/automationLifecycle"
import { parseAutomationInstanceBody, parseAutomationInstanceDiscovery,
  type AutomationInstanceRefreshBody } from "../domain/automationInstanceData"
import { verifyAutomationInstanceIdentity,
  type AutomationInstanceIdentityPayload, type AutomationInstanceIdentityProof } from "../domain/automationInstanceIdentity"
import { createAutomationInstanceRequest, type AutomationInstanceAction } from "../domain/automationInstanceProtocol"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import type { LocalProfile } from "../domain/identity"
import { verifyRustyWriterPolicyReceipt } from "../sync/rustyScopePolicy"

const maxResponseBytes = 384 * 1024
const actionSchema = z.enum(["discover", "identity", "activate", "refresh-access"])
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
