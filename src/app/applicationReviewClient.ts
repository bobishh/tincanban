import { requestWorkerJson } from "./workerJsonResponse"
import { automationBodyHash, verifyAutomationObservation, parseAutomationObservationProof, type AutomationObservation } from "../domain/automationProtocol"
import { isAutomationOrigin } from "../domain/automationLifecycle"
import { createApplicationReviewRequest } from "../domain/applicationReviewProtocol"
import { parseApplicationReviewBody, parseApplicationReviewDiscovery, parseApplicationReviewReceipt,
  parseApplicationReviewResponse, type ApplicationBindingReceipt, type ApplicationRetryReceipt,
  parseApplicationReviewMailbox, type ApplicationReviewAction, type ApplicationReviewMailbox, type ApplicationReviewResponse } from "../domain/applicationReviewData"
import { resolveLocalSigningContext } from "../domain/localSigningContext"
import type { LocalProfile } from "../domain/identity"
import type { ApplicationBindingProof } from "../domain/applicationBinding"

const maxResponseBytes = 384 * 1024

export class UnsupportedApplicationReviewError extends Error {
  constructor() { super("Worker does not support application review version 1"); this.name = "UnsupportedApplicationReviewError" }
}

export type ApplicationReviewClientGuards = {
  currentAuthority?: () => Promise<string>
  ensureCurrent?: () => void | Promise<void>
}
export type ApplicationReviewDiscoveryInput = {
  origin: string; workspaceId: string; definitionId: string; personId: string
}
export type ApplicationReviewReadInput = {
  origin: string; workspaceId: string; definitionId: string; integrationId: string; eventId: string; offset?: number
}
export type ApplicationReviewMailboxInput = {
  origin: string; workspaceId: string; definitionId: string; integrationId: string; personId: string; grantId: string
}
export type ApplicationReviewBindingInput = {
  origin: string; workspaceId: string; definitionId: string; integrationId: string; proof: ApplicationBindingProof
}
export type ApplicationReviewUnboundRetryInput = {
  origin: string; workspaceId: string; definitionId: string; integrationId: string; eventId: string
}

/** Find the one Worker integration matching the requested executor identity. */
export async function discoverApplicationReview(profile: LocalProfile, inputValue: ApplicationReviewDiscoveryInput,
  guards?: ApplicationReviewClientGuards): Promise<{ integrationId: string; personId: string }> {
  const profileSnapshot = structuredClone(profile)
  const input = structuredClone(inputValue)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  if (!input.personId || input.personId.length > 256 || !input.personId.trim()) throw new TypeError("Invalid application review executor identity")
  const body = parseApplicationReviewBody("discover", { workspaceId: input.workspaceId, definitionId: input.definitionId })
  const { value } = await send(profileSnapshot, input.origin, "discover", body, options)
  const discovery = parseApplicationReviewDiscovery(value)
  if (discovery.origin !== input.origin || discovery.workspaceId !== input.workspaceId || discovery.definitionId !== input.definitionId) {
    throw new Error("Application review discovery belongs to another origin, workspace or definition")
  }
  const matches = discovery.integrations.filter(integration => integration.personId === input.personId)
  if (matches.length !== 1) throw new Error("Application review discovery did not identify exactly one executor route")
  return { ...matches[0]! }
}

/** Read one bounded page of review data and verify every echoed request coordinate. */
export async function readApplicationReview(profile: LocalProfile, inputValue: ApplicationReviewReadInput,
  guards?: ApplicationReviewClientGuards): Promise<ApplicationReviewResponse> {
  const profileSnapshot = structuredClone(profile)
  const input = structuredClone(inputValue)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  const body = parseApplicationReviewBody("review", { workspaceId: input.workspaceId, definitionId: input.definitionId,
    integrationId: input.integrationId, eventId: input.eventId, ...(input.offset === undefined ? {} : { offset: input.offset }) })
  if (!("offset" in body)) throw new TypeError("Application review pagination is missing")
  const { value } = await send(profileSnapshot, input.origin, "review", body, options)
  const response = parseApplicationReviewResponse(value)
  if (response.origin !== input.origin || response.integrationId !== input.integrationId ||
    response.workspaceId !== input.workspaceId || response.definitionId !== input.definitionId ||
    response.eventId !== input.eventId || response.offset !== body.offset) {
    throw new Error("Application review response belongs to another request")
  }
  return response
}

/** Read mailbox bootstrap data and authenticate its fresh Worker observation for this executor. */
export async function readApplicationReviewMailbox(profile: LocalProfile, inputValue: ApplicationReviewMailboxInput,
  guards?: ApplicationReviewClientGuards): Promise<ApplicationReviewMailbox & { verifiedObservation: AutomationObservation }> {
  const profileSnapshot = structuredClone(profile)
  const input = structuredClone(inputValue)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  const body = parseApplicationReviewBody("list", { workspaceId: input.workspaceId, definitionId: input.definitionId,
    integrationId: input.integrationId })
  const { value, reviewRequest } = await send(profileSnapshot, input.origin, "list", body, options)
  const mailbox = parseApplicationReviewMailbox(value)
  if (mailbox.origin !== input.origin || mailbox.workspaceId !== input.workspaceId ||
    mailbox.definitionId !== input.definitionId || mailbox.integrationId !== input.integrationId) {
    throw new Error("Application review mailbox belongs to another request")
  }
  const observation = parseAutomationObservationProof(mailbox.observation)
  const verifiedObservation = await verifyAutomationObservation(observation, { personId: input.personId,
    origin: input.origin, integrationId: input.definitionId, workspaceId: input.workspaceId, grantId: input.grantId,
    nonce: reviewRequest.signed.payload.nonce })
  return { ...mailbox, observation, verifiedObservation }
}

/** Persist one owner-signed selection without changing its exact proof. */
export async function saveApplicationBinding(profile: LocalProfile, inputValue: ApplicationReviewBindingInput,
  guards?: ApplicationReviewClientGuards): Promise<ApplicationBindingReceipt> {
  const profileSnapshot = structuredClone(profile)
  const input = structuredClone(inputValue)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  const body = parseApplicationReviewBody("bind", { workspaceId: input.workspaceId, definitionId: input.definitionId,
    integrationId: input.integrationId, proof: input.proof })
  if (!("proof" in body)) throw new TypeError("Application binding proof is missing")
  const { value } = await send(profileSnapshot, input.origin, "bind", body, options)
  const receipt = parseApplicationReviewReceipt("bind", value)
  if (receipt.bindingId !== body.proof.signed.payload.bindingId) throw new Error("Worker binding receipt does not match the submitted proof")
  return receipt
}

/** Retry only the exact signed proof submitted by the current owner. */
export async function retryApplicationBinding(profile: LocalProfile, inputValue: ApplicationReviewBindingInput,
  guards?: ApplicationReviewClientGuards): Promise<ApplicationRetryReceipt> {
  const profileSnapshot = structuredClone(profile)
  const input = structuredClone(inputValue)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  const body = parseApplicationReviewBody("retry", { workspaceId: input.workspaceId, definitionId: input.definitionId,
    integrationId: input.integrationId, proof: input.proof })
  if (!("proof" in body)) throw new TypeError("Application binding proof is missing")
  const { value } = await send(profileSnapshot, input.origin, "retry", body, options)
  const receipt = parseApplicationReviewReceipt("retry", value)
  if (receipt.eventId !== body.proof.signed.payload.eventId) throw new Error("Worker retry receipt does not match the submitted proof")
  return receipt
}

/** Schedule ordinary processing for a retained unbound email; a bound event requires its exact owner selection. */
export async function retryUnboundApplicationReview(profile: LocalProfile, inputValue: ApplicationReviewUnboundRetryInput,
  guards?: ApplicationReviewClientGuards): Promise<ApplicationRetryReceipt> {
  const profileSnapshot = structuredClone(profile)
  const input = structuredClone(inputValue)
  const options = guards ? { ...guards } : undefined
  assertOrigin(input.origin)
  const body = parseApplicationReviewBody("retry-unbound", { workspaceId: input.workspaceId, definitionId: input.definitionId,
    integrationId: input.integrationId, eventId: input.eventId })
  if (!("eventId" in body)) throw new TypeError("Unbound application retry event is missing")
  const { value } = await send(profileSnapshot, input.origin, "retry-unbound", body, options)
  const receipt = parseApplicationReviewReceipt("retry", value)
  if (receipt.eventId !== body.eventId) throw new Error("Worker retry receipt does not match the submitted event")
  return receipt
}

async function send(profile: LocalProfile, origin: string, action: ApplicationReviewAction,
  body: unknown, guards?: ApplicationReviewClientGuards): Promise<{ value: unknown; reviewRequest: Awaited<ReturnType<typeof signRequest>> }> {
  await guards?.ensureCurrent?.()
  await assertSupported(origin, action)
  const reviewRequest = await signRequest(profile, origin, action, body, guards)
  await guards?.ensureCurrent?.()
  const value = await requestJson(origin, `/v2/application-review/${action}`, "POST", { reviewRequest, body })
  await guards?.ensureCurrent?.()
  return { value, reviewRequest }
}

async function assertSupported(origin: string, action: ApplicationReviewAction): Promise<void> {
  const capabilities = await requestJson(origin, "/v2/capabilities", "GET")
  if (!isRecord(capabilities) || capabilities.origin !== origin) throw new Error("Worker capability origin does not match its address")
  if (capabilities.version !== 2 || !isRecord(capabilities.applicationReview) || capabilities.applicationReview.version !== 1) {
    throw new UnsupportedApplicationReviewError()
  }
  const advertisedActions = capabilities.applicationReview.actions
  if (advertisedActions === undefined) {
    if (action === "retry-unbound") throw new UnsupportedApplicationReviewError()
    return
  }
  if (!Array.isArray(advertisedActions) || advertisedActions.length > 32 ||
    !advertisedActions.every(value => typeof value === "string") || new Set(advertisedActions).size !== advertisedActions.length) {
    throw new Error("Worker capability actions are invalid")
  }
  if (!advertisedActions.includes(action)) throw new UnsupportedApplicationReviewError()
}

async function signRequest(profile: LocalProfile, origin: string, action: ApplicationReviewAction,
  body: unknown, guards?: ApplicationReviewClientGuards) {
  const integrationId = isRecord(body) && typeof body.integrationId === "string" ? body.integrationId : null
  const bodyHash = await automationBodyHash(body)
  const binding: Record<string, string | number> = { action, origin, workspaceId: getString(body, "workspaceId"),
    definitionId: getString(body, "definitionId"), bodyHash, ...(integrationId ? { integrationId } : {}) }
  const context = await resolveLocalSigningContext(profile, "automation-application-review-request", binding,
    { ...(guards ?? {}), expiresAt: Date.now() + 60_000 })
  return createApplicationReviewRequest(context, { action, origin, workspaceId: binding.workspaceId as string,
    definitionId: binding.definitionId as string, integrationId, bodyHash })
}

async function requestJson(origin: string, path: string, method: "GET" | "POST", body?: unknown): Promise<unknown> {
  return requestWorkerJson(origin, path, method, maxResponseBytes, body)
}

function assertOrigin(origin: string): void {
  if (!isAutomationOrigin(origin)) throw new TypeError("Worker address must be an HTTPS origin")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function getString(value: unknown, key: string): string {
  if (!isRecord(value) || typeof value[key] !== "string") throw new TypeError(`Application review ${key} is missing`)
  return value[key] as string
}
