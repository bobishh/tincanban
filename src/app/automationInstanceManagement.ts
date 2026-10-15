import { isAutomationOrigin } from "../domain/automationLifecycle"
import { parseAutomationInstanceDescription, type AutomationInstanceDescription } from "../domain/automationInstanceData"
import type { AutomationInstanceIdentityPayload } from "../domain/automationInstanceIdentity"
import type { LocalProfile } from "../domain/identity"
import type { AutomationWorkerIdentity } from "./automation"
import { activateExistingAutomation, discoverAutomationInstance, readAutomationInstance,
  type AutomationInstanceClientGuards } from "./automationInstanceClient"

export type InspectedAutomationInstance = {
  identity: AutomationWorkerIdentity
  description: AutomationInstanceDescription
}
export type InspectExistingAutomationInput = {
  origin: string
  workspaceId: string
  definitionId: string
  executorPersonId: string
}
export type ReactivateExistingAutomationInput = {
  workspaceId: string
  packet: unknown
  explicitApproval: boolean
}

/** Resolve a single route, then expose only its verified public executor identity and current description. */
export async function inspectExistingAutomation(profileValue: LocalProfile, inputValue: InspectExistingAutomationInput,
  guardsValue?: AutomationInstanceClientGuards): Promise<InspectedAutomationInstance> {
  const profile = structuredClone(profileValue)
  const input = structuredClone(inputValue)
  const guards = guardsValue ? { ...guardsValue } : undefined
  assertOrigin(input.origin)
  await guards?.ensureCurrent?.()
  const { integrationId } = await discoverAutomationInstance(profile, input, guards)
  await guards?.ensureCurrent?.()
  const { proof, identity } = await readAutomationInstance(profile, { ...input, integrationId }, guards)
  await guards?.ensureCurrent?.()
  assertIdentityMatchesRoute(identity, input, integrationId)
  const description = parseAutomationInstanceDescription(identity.description)
  return { description, identity: workerIdentityFromProof(proof, identity, input, integrationId) }
}

/** Require explicit consent for legacy adoption or expired approvals; send the exact current packet unchanged. */
export async function reactivateExistingAutomation(profileValue: LocalProfile, inspectedValue: InspectedAutomationInstance,
  inputValue: ReactivateExistingAutomationInput, guardsValue?: AutomationInstanceClientGuards): Promise<void> {
  const profile = structuredClone(profileValue)
  const inspected = structuredClone(inspectedValue)
  const input = structuredClone(inputValue)
  const guards = guardsValue ? { ...guardsValue } : undefined
  const description = parseAutomationInstanceDescription(inspected.description)
  const worker = inspected.identity
  if (typeof input.explicitApproval !== "boolean") throw new TypeError("Explicit approval choice is required")
  if (description.state === "deleted") throw new Error("Deleted automation cannot be reactivated")
  requireApprovalIfNeeded(description, input.explicitApproval)
  assertDescriptionIdentity(description, worker)
  assertActivationPacket(input, description, worker)
  await guards?.ensureCurrent?.()
  await activateExistingAutomation(profile, { origin: worker.origin, workspaceId: input.workspaceId,
    definitionId: worker.definitionId!, executorPersonId: worker.personId, integrationId: worker.integrationId!,
    packet: input.packet, adoptLegacy: description.adoptionRequired }, guards)
  await guards?.ensureCurrent?.()
}

function assertIdentityMatchesRoute(identity: AutomationInstanceIdentityPayload,
  input: InspectExistingAutomationInput, integrationId: string): void {
  if (identity.origin !== input.origin || identity.workspaceId !== input.workspaceId ||
      identity.definitionId !== input.definitionId || identity.integrationId !== integrationId ||
      identity.executorPersonId !== input.executorPersonId) {
    throw new Error("Automation instance identity does not match the inspected route")
  }
}

function workerIdentityFromProof(proof: Awaited<ReturnType<typeof readAutomationInstance>>["proof"],
  identity: AutomationInstanceIdentityPayload, input: InspectExistingAutomationInput, integrationId: string): AutomationWorkerIdentity {
  const leaf = proof.certificates.filter(certificate => certificate.payload.personId === identity.executorPersonId &&
    certificate.payload.deviceId === identity.deviceId)
  if (leaf.length !== 1 || leaf[0]!.payload.devicePublicKey.length === 0 || proof.publicKey.length === 0 ||
      proof.signed.payload.deviceId !== identity.deviceId || proof.signed.payload.executorPersonId !== identity.executorPersonId) {
    throw new Error("Automation instance identity has no unique verified device leaf")
  }
  return { integrationId, definitionId: input.definitionId, origin: input.origin, personId: identity.executorPersonId,
    identityPublicKey: proof.publicKey, deviceId: identity.deviceId, devicePublicKey: leaf[0]!.payload.devicePublicKey,
    deviceCertificate: leaf[0]! }
}

function requireApprovalIfNeeded(description: AutomationInstanceDescription, explicitApproval: boolean): void {
  if (!explicitApproval && (description.adoptionRequired || description.expiresAt <= Date.now())) {
    throw new Error("Explicit approval is required to adopt or renew this automation")
  }
}

function assertDescriptionIdentity(description: AutomationInstanceDescription, worker: AutomationWorkerIdentity): void {
  if (description.executorPersonId !== worker.personId ||
      (description.definitionId !== worker.definitionId && !(description.definitionId === null && description.adoptionRequired))) {
    throw new Error("Automation instance description does not match its inspected identity")
  }
}

function assertActivationPacket(input: ReactivateExistingAutomationInput, description: AutomationInstanceDescription,
  worker: AutomationWorkerIdentity): void {
  if (input.workspaceId !== description.workspaceId || input.workspaceId !== packetWorkspace(input.packet) ||
      !isAutomationOrigin(worker.origin) || !worker.definitionId || !worker.integrationId ||
      packetDefinitionId(input.packet) !== worker.definitionId || packetGrantPerson(input.packet) !== worker.personId) {
    throw new Error("Automation activation packet does not match the inspected instance")
  }
}

function assertOrigin(origin: string): void {
  if (!isAutomationOrigin(origin)) throw new TypeError("Worker address must be an HTTPS origin")
}

function packetRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Automation activation packet is invalid")
  return value
}

function packetWorkspace(value: unknown): string {
  const packet = packetRecord(value)
  if (packet.version !== 2 || typeof packet.workspaceId !== "string") throw new TypeError("Automation activation packet is invalid")
  return packet.workspaceId
}

function packetDefinitionId(value: unknown): string {
  const definition = packetRecord(value).definition
  if (!isRecord(definition) || !isRecord(definition.payload) || typeof definition.payload.id !== "string") {
    throw new TypeError("Automation activation definition is missing")
  }
  return definition.payload.id
}

function packetGrantPerson(value: unknown): string {
  const grant = packetRecord(value).grant
  if (!isRecord(grant) || !isRecord(grant.payload) || typeof grant.payload.personId !== "string") {
    throw new TypeError("Automation activation grant is missing")
  }
  return grant.payload.personId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
