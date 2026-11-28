import { canonicalizeJson } from "../domain/identityCrypto"
import { automationBodyHash, type AutomationOwnerRequestInput } from "../domain/automationProtocol"
import type { AutomationWorkerIdentity, AutomationConfiguration } from "./automation"
import { automationTypes } from "../domain/automationContract"
import { automationActivationResponseTimeoutMs, requestWorkerJson } from "./workerJsonResponse"
import type { AutomationInstanceRelay, AutomationInstanceReadInput } from "./automationInstanceClient"
import { withLocalStateWriteLock } from "../localStateLock"

export type AutomationConnectionRequest = {
  kind: "mesh-reflux-automation-request"; version: 1
  reflux_origin: string; workflow_slug: string; intent_id: string; owner_person_id: string
  expires_at: number; handoff_code: string; return_to: string
}
export type ResolvedAutomationConnection = {
  integrationId: string; automationOrigin: string; workflowSlug: string; workflowTitle: string
  ownerPersonId: string; expiresAt: number; returnTo: string
  configuration: AutomationConfiguration
  existing?: { workspaceId: string; executorPersonId: string } | null
}
type ConnectionStore = { load(): Promise<string | null>; save(value: string): Promise<void> }
type RetainedApproval = { binding: string; workspaceId: string; fingerprint: string; packet?: string; identity?: AutomationWorkerIdentity; active?: boolean; completedIntent?: string }
type ConnectionOptions = {
  request: AutomationConnectionRequest
  store: ConnectionStore
  sign(input: AutomationOwnerRequestInput): Promise<unknown>
  exportPacket(identity: AutomationWorkerIdentity, workspaceId: string): Promise<string>
  existing?: {
    store?(target: AutomationInstanceReadInput): ConnectionStore
    prepare(target: AutomationInstanceReadInput, relay: AutomationInstanceRelay): Promise<{ packet: string; identity?: AutomationWorkerIdentity }>
    activate(target: AutomationInstanceReadInput, relay: AutomationInstanceRelay, packet: unknown): Promise<void>
  }
  registerServiceAccess?(identity: AutomationWorkerIdentity, packet: unknown): Promise<void>
  ensureCurrent?(): void
  fetcher?: typeof fetch
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const publicId = /^[A-Za-z0-9_-]{43}$/u
function secureOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false
  try {
    const url = new URL(value)
    return value === url.origin && (url.protocol === "https:" || url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  } catch { return false }
}

/** Navigation carries a short-lived connection intent, never a grant or workspace bootstrap. */
export function parseAutomationConnectionRequest(value: unknown): AutomationConnectionRequest {
  const input = value as AutomationConnectionRequest
  const now = Date.now()
  if (!input || input.kind !== "mesh-reflux-automation-request" || input.version !== 1 ||
      !secureOrigin(input.reflux_origin) || !uuid.test(input.intent_id) || !publicId.test(input.owner_person_id) ||
      !publicId.test(input.handoff_code) || !/^[a-z0-9][a-z0-9-]{0,80}$/u.test(input.workflow_slug) ||
      !Number.isSafeInteger(input.expires_at) || input.expires_at <= now || input.expires_at > now + 15 * 60_000) {
    throw new Error("Automation connection request is invalid or expired. Start again in Reflux.")
  }
  const returnPaths = [`/workflows/${input.workflow_slug}/edit`, `/workflows/${input.workflow_slug}`]
  const allowedReturn = returnPaths.some(path => {
    const expected = new URL(path, input.reflux_origin)
    expected.searchParams.set("automation_connection", input.intent_id)
    return input.return_to === expected.href
  })
  if (!allowedReturn) throw new Error("Automation return address does not match the requesting workflow")
  return structuredClone(input)
}

function existingConnectionTarget(resolved: ResolvedAutomationConnection, workspaceId: string): AutomationInstanceReadInput | undefined {
  if (!resolved.existing) return
  if (resolved.existing.workspaceId !== workspaceId) throw new Error("Approve access on the existing board")
  return { ...resolved.existing, integrationId: resolved.integrationId, definitionId: resolved.integrationId, origin: resolved.automationOrigin }
}

function validateResolvedAccess(result: Record<string, unknown>) {
    const configuration = result.configuration as AutomationConfiguration | undefined
    const type = automationTypes.find(type => type.type === configuration?.type && type.version === configuration.typeVersion)
    if (!type || !configuration || typeof configuration.name !== "string" || !configuration.name.trim() || configuration.name.length > 100) {
      throw new Error("Reflux requested an unsupported automation configuration")
    }
    const existing = result.existing as ResolvedAutomationConnection["existing"]
    if (existing != null && (typeof existing.workspaceId !== "string" || !existing.workspaceId ||
      existing.workspaceId.length > 128 || !publicId.test(existing.executorPersonId))) {
      throw new Error("Reflux connection does not identify an existing board and participant")
    }
    configuration.parameters = type.parameters.parse(configuration.parameters)
}

/** Retain one approved bootstrap before delivery, so a lost reply cannot issue a second grant. */
export function createAutomationConnection(options: ConnectionOptions) {
  const request = parseAutomationConnectionRequest(options.request)
  const path = `/api/automation-connections/${request.intent_id}`
  const binding = canonicalizeJson([request.reflux_origin, request.workflow_slug, request.intent_id, request.owner_person_id])
  const check = () => { parseAutomationConnectionRequest(request); options.ensureCurrent?.() }
  async function send(operation: string, body: Record<string, unknown> = {}) {
    check()
    const result = await requestWorkerJson(request.reflux_origin, `${path}/${operation}`, "POST", (operation === "instance" ? 384 : 64) * 1024,
      { ...body, handoffCode: request.handoff_code }, "Reflux returned an invalid connection response", options.fetcher,
      operation === "instance" && body.action === "activate" ? automationActivationResponseTimeoutMs : undefined)
    check()
    return result as Record<string, unknown>
  }
  async function resolve(): Promise<ResolvedAutomationConnection> {
    const result = await send("resolve")
    if (!uuid.test(String(result.integrationId)) || !secureOrigin(result.automationOrigin) ||
        result.workflowSlug !== request.workflow_slug || result.ownerPersonId !== request.owner_person_id ||
        result.expiresAt !== request.expires_at || result.returnTo !== request.return_to ||
        typeof result.workflowTitle !== "string" || result.workflowTitle.length > 256) {
      throw new Error("Reflux connection no longer matches this approval request")
    }
    validateResolvedAccess(result)
    return result as ResolvedAutomationConnection
  }
  async function approve(personId: string, workspaceId: string, fingerprint: string): Promise<string> {
    if (personId !== request.owner_person_id) throw new Error("Sign in with the workflow owner’s Identity before approving")
    if (!workspaceId) throw new Error("Select an existing board")
    return withLocalStateWriteLock(`automation-connection:${request.intent_id}`, async () => {
      check()
      const resolved = await resolve()
      const target = existingConnectionTarget(resolved, workspaceId)
      const retained = target && options.existing?.store?.(target)
      const store = retained || options.store
      const approvalBinding = retained ? canonicalizeJson([request.reflux_origin, request.owner_person_id, target]) : binding
      const state = await readApproval(store, approvalBinding, workspaceId, fingerprint)
      if (state.active && (!retained || state.completedIntent === request.intent_id)) return resolved.returnTo
      if (target) await activateApprovedExisting(state, target, store)
      else await activateApprovedNew(state, resolved, workspaceId)
      state.active = true
      state.completedIntent = request.intent_id
      delete state.packet
      delete state.identity
      await store.save(JSON.stringify(state))
      return resolved.returnTo
    })
  }
  async function activateApprovedExisting(state: RetainedApproval, target: AutomationInstanceReadInput, store: ConnectionStore) {
    const relay: AutomationInstanceRelay = (action, instanceRequest, body) => send("instance", { action, instanceRequest, body })
    const existing = options.existing
    if (!existing) throw new Error("Existing connection upgrade is unavailable")
    if (!state.packet) {
      Object.assign(state, await existing.prepare(target, relay))
      check()
      await store.save(JSON.stringify(state))
    }
    const packet: unknown = JSON.parse(state.packet!)
    await registerBeforeActivation(state, packet)
    await existing.activate(target, relay, packet)
  }

  async function activateApprovedNew(state: RetainedApproval, resolved: ResolvedAutomationConnection, workspaceId: string) {
    if (!state.packet) {
      const ownerRequest = await options.sign({ action: "enroll", origin: resolved.automationOrigin,
        workspaceId, integrationId: resolved.integrationId, bodyHash: null })
      const enrolled = await send("enrollment", { workspaceId, ownerRequest })
      const identity = enrolled.identity as AutomationWorkerIdentity | undefined
      if (enrolled.state !== "enrolled" || enrolled.integrationId !== resolved.integrationId ||
          enrolled.workspaceId !== workspaceId || !identity || identity.integrationId !== resolved.integrationId ||
          identity.origin !== resolved.automationOrigin) throw new Error("Automation identity does not match this connection")
      state.packet = await options.exportPacket(identity, workspaceId)
      state.identity = identity
      check()
      await options.store.save(JSON.stringify(state))
    }
    const packet: unknown = JSON.parse(state.packet)
    await registerBeforeActivation(state, packet)
    const ownerRequest = await options.sign({ action: "activate", origin: resolved.automationOrigin,
      workspaceId, integrationId: resolved.integrationId, bodyHash: await automationBodyHash(packet) })
    const result = await send("activation", { ownerRequest, packet })
    if (result.state !== "active" || result.integrationId !== resolved.integrationId || result.returnTo !== resolved.returnTo) {
      throw new Error("Reflux has not confirmed the automation connection. Retry the same approval.")
    }
  }
  async function registerBeforeActivation(state: RetainedApproval, packet: unknown) {
    if (!options.registerServiceAccess) return
    if (!state.identity) throw new Error("The approved service identity is unavailable. Start a new request in Reflux.")
    check()
    await options.registerServiceAccess(state.identity, packet)
    check()
  }
  async function readApproval(store: ConnectionStore, binding: string, workspaceId: string, fingerprint: string): Promise<RetainedApproval> {
    const raw = await store.load()
    const previous = raw === null ? null : JSON.parse(raw) as RetainedApproval
    if (previous && (previous.binding !== binding || previous.workspaceId !== workspaceId)) {
      throw new Error("This connection was already approved for a different board. Start a new request in Reflux.")
    }
    if (!fingerprint || previous && previous.fingerprint !== fingerprint) {
      throw new Error("Board automation scope changed after approval. Start a new request in Reflux.")
    }
    return previous ?? { binding, workspaceId, fingerprint }
  }
  async function decline() { await send("denial"); return request.return_to }
  return { resolve, approve, decline }
}
