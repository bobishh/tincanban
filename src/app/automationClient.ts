import { defaultProofStore } from "../domain/proofs"
import { automationBodyHash, createAutomationOwnerRequest, verifyAutomationObservation } from "../domain/automationProtocol"
import { isAutomationOrigin } from "../domain/automationLifecycle"
import { automationTypes } from "../domain/automationContract"
import type { LocalProfile } from "../domain/identity"
import type { AutomationWorkerIdentity } from "./automation"

export function automationOrigin(address: string): string {
  const origin = address.trim().replace(/\/$/, "")
  if (!isAutomationOrigin(origin)) throw new Error("Worker address must be an HTTPS origin")
  return origin
}

async function requestJson(origin: string, path: string, body?: unknown, method = "POST"): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, { method, mode: "cors", credentials: "omit", redirect: "error",
    signal: AbortSignal.timeout(15_000), ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) })
  // Responses contain public identity and small receipts, never the activation document.
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Worker returned an empty response")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 64 * 1024) { await reader.cancel(); throw new Error("Worker response exceeds the size limit") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  let result: unknown
  try { result = JSON.parse(new TextDecoder().decode(bytes)) }
  catch { throw new Error("Address is not an automation Worker") }
  if (!response.ok) throw new Error(result && typeof result === "object" && "error" in result ? String(result.error) : `Worker returned ${response.status}`)
  return result
}

export async function enrollAutomation(profile: LocalProfile, origin: string, workspaceId: string, integrationId: string): Promise<AutomationWorkerIdentity> {
  const capabilities = await requestJson(origin, "/v2/capabilities", undefined, "GET") as { version?: unknown; origin?: unknown; enrollment?: unknown; types?: Array<{ type: string; version: number }> }
  if (capabilities.version !== 2 || capabilities.origin !== origin || !capabilities.enrollment ||
    !capabilities.types?.some(value => value.type === automationTypes[0].type && value.version === automationTypes[0].version)) {
    throw new Error("Worker does not support owner enrollment for this automation type")
  }
  const ownerRequest = await createAutomationOwnerRequest(profile, { action: "enroll", origin, workspaceId, integrationId, bodyHash: null }, await defaultProofStore.listCertificates())
  const identity = await requestJson(origin, `/v2/integrations/${integrationId}/identity`, { ownerRequest }) as AutomationWorkerIdentity
  if (identity.origin !== origin || identity.integrationId !== integrationId) throw new Error("Worker identity belongs to another origin or instance")
  return identity
}

export async function activateAutomation(profile: LocalProfile, identity: AutomationWorkerIdentity, workspaceId: string, packet: unknown): Promise<void> {
  if (!identity.integrationId) throw new Error("Worker instance is missing")
  const ownerRequest = await createAutomationOwnerRequest(profile, { action: "activate", origin: identity.origin, workspaceId,
    integrationId: identity.integrationId, bodyHash: await automationBodyHash(packet) }, await defaultProofStore.listCertificates())
  await requestJson(identity.origin, `/v2/integrations/${identity.integrationId}/activation`, { ownerRequest, packet }, "PUT")
}

export async function observeAutomation(profile: LocalProfile, input: { origin: string; integrationId: string; workspaceId: string; personId: string; grantId: string }) {
  const ownerRequest = await createAutomationOwnerRequest(profile, { action: "observe", origin: input.origin,
    workspaceId: input.workspaceId, integrationId: input.integrationId, bodyHash: null }, await defaultProofStore.listCertificates())
  const receipt = await requestJson(input.origin, `/v2/integrations/${input.integrationId}/observation`, { ownerRequest })
  return verifyAutomationObservation(receipt, { ...input, nonce: ownerRequest.signed.payload.nonce })
}

export type AutomationEmailSetup = {
  route: { address: string; mailbox: string } | null
  receipt: { confirmation: { eventId: string; url: string } | null;
    events: Array<{ eventId: string; status: string; createdAt: number }> }
}

export async function readAutomationEmail(profile: LocalProfile, input: { origin: string; integrationId: string; workspaceId: string }): Promise<AutomationEmailSetup> {
  const ownerRequest = await createAutomationOwnerRequest(profile, { action: "email", origin: input.origin,
    workspaceId: input.workspaceId, integrationId: input.integrationId, bodyHash: null }, await defaultProofStore.listCertificates())
  return await requestJson(input.origin, `/v2/integrations/${input.integrationId}/email`, { ownerRequest }) as AutomationEmailSetup
}
