import { requestWorkerJson } from "./workerJsonResponse"
import { automationBodyHash, createAutomationOwnerRequest as createVerifiedOwnerRequest, verifyAutomationObservation,
  type AutomationOwnerRequestInput } from "../domain/automationProtocol"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import { isAutomationOrigin } from "../domain/automationLifecycle"
import { automationTypes, type AutomationDefinition } from "../domain/automationContract"
import type { LocalProfile } from "../domain/identity"
import type { AutomationWorkerIdentity } from "./automation"

export function automationOrigin(address: string): string {
  const origin = address.trim().replace(/\/$/, "")
  if (!isAutomationOrigin(origin)) throw new Error("Worker address must be an HTTPS origin")
  return origin
}

async function createOwnerRequest(profile: LocalProfile, input: AutomationOwnerRequestInput) {
  const payload = structuredClone(input)
  const context = await resolveLocalSigningContext(profile, "automation-owner-request", {
    origin: payload.origin, workspaceId: payload.workspaceId, integrationId: payload.integrationId,
    action: payload.action, personId: profile.identity.personId,
  }, { expiresAt: Date.now() + 60_000 })
  return createVerifiedOwnerRequest(context, payload)
}

async function requestJson(origin: string, path: string, body?: unknown, method: "GET" | "POST" | "PUT" = "POST"): Promise<unknown> {
  return requestWorkerJson(origin, path, method, 64 * 1024, body, "Address is not an automation Worker")
}

export async function enrollAutomation(profile: LocalProfile, origin: string, workspaceId: string, integrationId: string,
  requiredType: Pick<AutomationDefinition, "type" | "typeVersion"> = { type: automationTypes[0]!.type, typeVersion: automationTypes[0]!.version }): Promise<AutomationWorkerIdentity> {
  profile = structuredClone(profile)
  requiredType = { ...requiredType }
  const capabilities = await requestJson(origin, "/v2/capabilities", undefined, "GET") as { version?: unknown; origin?: unknown; enrollment?: unknown; types?: Array<{ type: string; version: number }> }
  if (capabilities.version !== 2 || capabilities.origin !== origin || !capabilities.enrollment ||
    !automationTypes.some(value => value.type === requiredType.type && value.version === requiredType.typeVersion) ||
    !capabilities.types?.some(value => value.type === requiredType.type && value.version === requiredType.typeVersion)) {
    throw new Error("Worker does not support owner enrollment for this automation type")
  }
  const ownerRequest = await createOwnerRequest(profile, { action: "enroll", origin, workspaceId, integrationId, bodyHash: null })
  const identity = await requestJson(origin, `/v2/integrations/${integrationId}/identity`, { ownerRequest }) as AutomationWorkerIdentity
  if (identity.origin !== origin || identity.integrationId !== integrationId) throw new Error("Worker identity belongs to another origin or instance")
  return identity
}

export async function activateAutomation(profile: LocalProfile, identity: AutomationWorkerIdentity, workspaceId: string, packet: unknown): Promise<void> {
  profile = structuredClone(profile)
  identity = structuredClone(identity)
  packet = structuredClone(packet)
  if (!identity.integrationId) throw new Error("Worker instance is missing")
  const ownerRequest = await createOwnerRequest(profile, { action: "activate", origin: identity.origin, workspaceId,
    integrationId: identity.integrationId, bodyHash: await automationBodyHash(packet) })
  await requestJson(identity.origin, `/v2/integrations/${identity.integrationId}/activation`, { ownerRequest, packet }, "PUT")
}

export async function observeAutomation(profile: LocalProfile, input: { origin: string; integrationId: string; workspaceId: string; personId: string; grantId: string }) {
  input = { ...input }
  const ownerRequest = await createOwnerRequest(profile, { action: "observe", origin: input.origin,
    workspaceId: input.workspaceId, integrationId: input.integrationId, bodyHash: null })
  const receipt = await requestJson(input.origin, `/v2/integrations/${input.integrationId}/observation`, { ownerRequest })
  return verifyAutomationObservation(receipt, { ...input, nonce: ownerRequest.signed.payload.nonce })
}

export type AutomationEmailSetup = {
  route: { address: string; mailbox: string } | null
  receipt: { confirmation: { eventId: string; url: string } | null;
    events: Array<{ eventId: string; status: string; createdAt: number; subject?: string; result?: { reason?: string } }> }
}

export async function readAutomationEmail(profile: LocalProfile, input: { origin: string; integrationId: string; workspaceId: string }): Promise<AutomationEmailSetup> {
  input = { ...input }
  const ownerRequest = await createOwnerRequest(profile, { action: "email", origin: input.origin,
    workspaceId: input.workspaceId, integrationId: input.integrationId, bodyHash: null })
  return await requestJson(input.origin, `/v2/integrations/${input.integrationId}/email`, { ownerRequest }) as AutomationEmailSetup
}

export async function retryAutomationEmail(profile: LocalProfile, input: { origin: string; integrationId: string; workspaceId: string }, eventId: string) {
  profile = structuredClone(profile)
  input = { ...input }
  const body = { retryEventId: eventId }
  const ownerRequest = await createOwnerRequest(profile, { action: "email", ...input, bodyHash: await automationBodyHash(body) })
  return requestJson(input.origin, `/v2/integrations/${input.integrationId}/email`, { ...body, ownerRequest })
}
