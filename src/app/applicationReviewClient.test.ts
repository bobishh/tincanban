import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { automationBodyHash } from "../domain/automationProtocol"
import { createDelegatedCertificate, certHashDefault, defaultProofStore } from "../domain/proofs"
import { bootstrapIdentity, clearInMemoryProfileForReloadTest, resetIdentityStorageForTest, signEnvelope, toBase64Url, type LocalProfile } from "../domain/identity"
import { profileFromIdentitySeedForDevice, identitySeedFromPrivateKey } from "@meta-uber/mesh-identity"
import { type ApplicationReviewResponse } from "../domain/applicationReviewData"
import { verifyApplicationReviewRequest, type ApplicationReviewRequestInput } from "../domain/applicationReviewProtocol"
import { verifyDeviceProofSignature } from "../domain/deviceProof"
import { writeLocal } from "../localDb"
import type { ApplicationBindingProof } from "../domain/applicationBinding"
import { readApplicationReviewMailbox } from "./applicationReviewClient"
import { discoverApplicationReview, readApplicationReview, retryApplicationBinding, saveApplicationBinding,
  retryUnboundApplicationReview, UnsupportedApplicationReviewError } from "./applicationReviewClient"

const origin = "https://automation.example.test"
const workspaceId = "workspace-1"
const definitionId = "existing-definition"
const integrationId = "legacy_worker-1"
const eventId = "A".repeat(32)
const eventHash = "B".repeat(43)

function reviewResponse(overrides: Partial<ApplicationReviewResponse> = {}): ApplicationReviewResponse {
  return {
    kind: "automation-application-review", version: 1, origin, integrationId, definitionId, workspaceId,
    eventId, eventHash, decisionHash: null, decisionEvent: "unclassified", status: "review",
    subject: "Application update", text: "Review the saved application message.", sentAt: null,
    grantId: "grant-1", accessEpoch: 3, automationState: "active", binding: null,
    options: [], total: 0, offset: 0, hasMore: false, ...overrides,
  }
}

function bindingProof(bindingId = "5f1bd4ce-13ca-4d45-a32d-40a2165df521"): ApplicationBindingProof {
  return { publicKey: owner.identity.publicKey, certificates: [owner.certificate], signed: { signerKeyId: owner.device.deviceId,
    signature: "synthetic", payload: { kind: "automation-application-binding", version: 1, bindingId, previousBindingId: null,
      origin, integrationId, definitionId, workspaceId, cardId: "card-1", grantId: "grant-1", eventId,
      eventHash, decisionHash: "C".repeat(43), sourceRecordId: "source-1", sourceHash: "D".repeat(43), accessEpoch: 3,
      workflow: { columnId: "applied", changedAt: "2026-10-14T10:00:00.000Z" }, personId: owner.identity.personId,
      deviceId: owner.device.deviceId, issuedAt: Date.now() } } } as unknown as ApplicationBindingProof
}

type RecordedRequest = { url: string; init: RequestInit; body?: Record<string, unknown> }
let owner: LocalProfile
let requests: RecordedRequest[]
let responder: (request: RecordedRequest) => Promise<Response> | Response

beforeEach(async () => {
  resetIdentityStorageForTest()
  owner = await bootstrapIdentity("Review owner")
  requests = []
  responder = request => {
    if (request.url.endsWith("/v2/capabilities")) return Response.json({ version: 2, origin, applicationReview: { version: 1 } })
    const action = request.url.split("/").at(-1)
    if (action === "discover") return Response.json({ origin, workspaceId, definitionId,
      integrations: [{ integrationId, personId: "executor-1" }] })
    if (action === "review") return Response.json(reviewResponse())
    if (action === "bind") return Response.json({ bindingId: "5f1bd4ce-13ca-4d45-a32d-40a2165df521", duplicate: false })
    return Response.json({ eventId, status: "pending", duplicate: false })
  }
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const body = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined
    const request = { url, init, ...(body ? { body } : {}) }
    requests.push(request)
    return responder(request)
  }))
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetIdentityStorageForTest() })

async function verifySentRequest(request: RecordedRequest, action: string, body: Record<string, unknown>, expectedIntegrationId: string | null) {
  expect(request.init.mode).toBe("cors")
  expect(request.init.credentials).toBe("omit")
  expect(request.init.redirect).toBe("error")
  expect(request.init.signal).toBeInstanceOf(AbortSignal)
  expect(request.body).toEqual(expect.objectContaining({ body }))
  expect(JSON.stringify(request.body)).not.toMatch(/privateKey|pkcs8|deviceEntropy|identitySeed/i)
  const reviewRequest = request.body!.reviewRequest as Parameters<typeof verifyApplicationReviewRequest>[0]
  const bodyHash = await automationBodyHash(body)
  const payload = await verifyApplicationReviewRequest(reviewRequest, { action: action as ApplicationReviewRequestInput["action"], origin, workspaceId,
    definitionId, integrationId: expectedIntegrationId, bodyHash })
  expect(payload.personId).toBe(owner.identity.personId)
}

describe("application review HTTP client", () => {
  it("Given a signed Worker observation, When reading mailbox bootstrap, Then bind it to the fresh request nonce and exact route", async () => {
    const grantId = "grant-mailbox"
    const makeObservation = async (overrides: Record<string, unknown> = {}, signer = owner) => {
      const payload = { kind: "automation-observation", version: 1, origin, integrationId: definitionId, workspaceId,
        grantId, nonce: (requests.at(-1)!.body!.reviewRequest as { signed: { payload: { nonce: string } } }).signed.payload.nonce,
        issuedAt: Date.now(), state: "active", heads: ["5f1bd4ce-13ca-4d45-a32d-40a2165df521"], ...overrides }
      return { publicKey: owner.identity.publicKey, certificates: [owner.certificate],
        signed: await signEnvelope(signer.privateKeys.devicePrivateKey, payload, signer.device.deviceId) }
    }
    const mailboxValue = (observation: unknown, scope: Record<string, unknown> = {}) => ({
      origin, workspaceId, definitionId, integrationId, route: null,
      receipt: { confirmation: null, events: [] }, observation, ...scope,
    })
    responder = async request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : Response.json(mailboxValue(await makeObservation()))
    const result = await readApplicationReviewMailbox(owner, { origin, workspaceId, definitionId, integrationId,
      personId: owner.identity.personId, grantId })
    expect(result.verifiedObservation).toMatchObject({ integrationId: definitionId, grantId, workspaceId })
    const request = requests.find(value => value.url.endsWith("/list"))!
    await verifySentRequest(request, "list", { workspaceId, definitionId, integrationId }, integrationId)

    for (const override of [
      { grantId: "other-grant" },
      { origin: "https://other.example.test" },
      { nonce: crypto.randomUUID() },
    ]) {
      responder = async value => value.url.endsWith("/v2/capabilities")
        ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
        : Response.json(mailboxValue(await makeObservation(override)))
      await expect(readApplicationReviewMailbox(owner, { origin, workspaceId, definitionId, integrationId,
        personId: owner.identity.personId, grantId })).rejects.toThrow()
    }
    const seed = await identitySeedFromPrivateKey(owner.privateKeys.identityPrivateKey!, owner.identity.personId)
    const other = await profileFromIdentitySeedForDevice(seed, "Other mailbox device", new Uint8Array(32).fill(43))
    responder = async value => value.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : Response.json(mailboxValue(await makeObservation({}, other)))
    await expect(readApplicationReviewMailbox(owner, { origin, workspaceId, definitionId, integrationId,
      personId: owner.identity.personId, grantId })).rejects.toThrow()
    responder = async requestValue => requestValue.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : Response.json(mailboxValue(await makeObservation(), { integrationId: "foreign-worker" }))
    await expect(readApplicationReviewMailbox(owner, { origin, workspaceId, definitionId, integrationId,
      personId: owner.identity.personId, grantId })).rejects.toThrow(/another request/i)
  })

  it("Given an executor identity and legacy route ID, When discovering, Then choose its unique matching route and sign the exact request", async () => {
    const result = await discoverApplicationReview(owner, { origin, workspaceId, definitionId, personId: "executor-1" })
    expect(result).toEqual({ integrationId, personId: "executor-1" })
    expect(requests.map(request => request.url)).toEqual([`${origin}/v2/capabilities`, `${origin}/v2/application-review/discover`])
    await verifySentRequest(requests[1]!, "discover", { workspaceId, definitionId }, null)
  })

  it("Given review, bind and retry actions, When sent, Then validate exact reply scope and action receipt", async () => {
    const review = reviewResponse()
    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : request.url.endsWith("/review") ? Response.json(review)
        : request.url.endsWith("/bind") ? Response.json({ bindingId: "5f1bd4ce-13ca-4d45-a32d-40a2165df521", duplicate: false })
          : Response.json({ eventId, status: "pending", duplicate: false })
    await expect(readApplicationReview(owner, { origin, workspaceId, definitionId, integrationId, eventId, offset: 0 }))
      .resolves.toMatchObject({ eventId, integrationId })
    const proof = bindingProof()
    await expect(saveApplicationBinding(owner, { origin, workspaceId, definitionId, integrationId, proof }))
      .resolves.toMatchObject({ bindingId: proof.signed.payload.bindingId, duplicate: false })
    await expect(retryApplicationBinding(owner, { origin, workspaceId, definitionId, integrationId, proof }))
      .resolves.toMatchObject({ eventId, status: "pending" })
    expect(requests.filter(request => request.url.includes("/application-review/")).map(request => request.url.split("/").at(-1)))
      .toEqual(["review", "bind", "retry"])
    for (const request of requests.filter(value => value.url.includes("/application-review/") && value.body)) {
      const action = request.url.split("/").at(-1)!
      await verifySentRequest(request, action, request.body!.body as Record<string, unknown>, integrationId)
    }
  })

  it("Given retained unbound email, When retrying, Then send the exact signed body and verify the event receipt", async () => {
    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1, actions: ["retry-unbound"] } })
      : Response.json({ eventId, status: "pending", duplicate: false })
    const input = { origin, workspaceId, definitionId, integrationId, eventId }
    await expect(retryUnboundApplicationReview(owner, input)).resolves.toEqual({ eventId, status: "pending", duplicate: false })
    const request = requests.find(value => value.url.endsWith("/retry-unbound"))!
    const body = { workspaceId, definitionId, integrationId, eventId }
    expect(Object.keys(request.body!.body as Record<string, unknown>).sort())
      .toEqual(["definitionId", "eventId", "integrationId", "workspaceId"])
    await verifySentRequest(request, "retry-unbound", body, integrationId)

    responder = value => value.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1, actions: ["retry-unbound"] } })
      : Response.json({ eventId: "B".repeat(32), status: "pending", duplicate: false })
    await expect(retryUnboundApplicationReview(owner, input)).rejects.toThrow(/does not match/i)
  })

  it("Given a Worker without the explicit retry-unbound capability, When retrying, Then fail before sending action", async () => {
    responder = () => Response.json({ version: 2, origin, applicationReview: { version: 1, actions: ["discover", "retry"] } })
    await expect(retryUnboundApplicationReview(owner, { origin, workspaceId, definitionId, integrationId, eventId }))
      .rejects.toBeInstanceOf(UnsupportedApplicationReviewError)
    expect(requests.map(request => request.url)).toEqual([`${origin}/v2/capabilities`])

    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : Response.json({ origin, workspaceId, definitionId, integrations: [{ integrationId, personId: "executor-1" }] })
    await expect(discoverApplicationReview(owner, { origin, workspaceId, definitionId, personId: "executor-1" }))
      .resolves.toMatchObject({ integrationId })
  })

  it("Given an authorized client request, When Worker denies retry, Then preserve its HTTP authorization failure", async () => {
    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1, actions: ["retry-unbound"] } })
      : Response.json({ error: "Forbidden" }, { status: 403 })
    await expect(retryUnboundApplicationReview(owner, { origin, workspaceId, definitionId, integrationId, eventId }))
      .rejects.toThrow(/forbidden/i)
    expect(requests.map(request => request.url)).toEqual([
      `${origin}/v2/capabilities`, `${origin}/v2/application-review/retry-unbound`,
    ])
  })

  it("Given malformed advertised actions, When retrying, Then reject invalid capability instead of allowing old API fallback", async () => {
    for (const actions of ["retry-unbound", ["retry-unbound", 7], ["retry-unbound", "retry-unbound"]]) {
      responder = () => Response.json({ version: 2, origin, applicationReview: { version: 1, actions } })
      await expect(retryUnboundApplicationReview(owner, { origin, workspaceId, definitionId, integrationId, eventId }))
        .rejects.toThrow(/capability.*actions/i)
    }
  })

  it("Given mismatched discovery, review or receipt scope, When returned by Worker, Then reject without selecting another identity", async () => {
    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : Response.json({ origin, workspaceId, definitionId: "other-definition", integrations: [
        { integrationId: "worker-a", personId: "executor-1" }, { integrationId: "worker-b", personId: "executor-1" },
      ] })
    await expect(discoverApplicationReview(owner, { origin, workspaceId, definitionId, personId: "executor-1" })).rejects.toThrow()
    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : Response.json({ origin, workspaceId, definitionId, integrations: [
        { integrationId: "worker-a", personId: "executor-1" }, { integrationId: "worker-b", personId: "executor-1" },
      ] })
    await expect(discoverApplicationReview(owner, { origin, workspaceId, definitionId, personId: "executor-1" }))
      .rejects.toThrow(/exactly one/i)
    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : Response.json(reviewResponse({ offset: 1 }))
    await expect(readApplicationReview(owner, { origin, workspaceId, definitionId, integrationId, eventId, offset: 0 })).rejects.toThrow()
    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : Response.json(reviewResponse({ integrationId: "other-worker" }))
    await expect(readApplicationReview(owner, { origin, workspaceId, definitionId, integrationId, eventId, offset: 0 })).rejects.toThrow()
    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : Response.json({ bindingId: "5f1bd4ce-13ca-4d45-a32d-40a2165df521", duplicate: false })
    const proof = bindingProof("6f1bd4ce-13ca-4d45-a32d-40a2165df521")
    await expect(saveApplicationBinding(owner, { origin, workspaceId, definitionId, integrationId, proof })).rejects.toThrow()
    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : Response.json({ eventId: "B".repeat(32), status: "pending", duplicate: false })
    await expect(retryApplicationBinding(owner, { origin, workspaceId, definitionId, integrationId,
      proof: bindingProof() })).rejects.toThrow(/does not match/i)
  })

  it("Given unsupported capability, 403, malformed JSON or oversized response, When requested, Then never fallback or disguise authorization failure", async () => {
    responder = () => Response.json({ version: 2, origin, applicationReview: { version: 2 } })
    await expect(discoverApplicationReview(owner, { origin, workspaceId, definitionId, personId: "executor-1" }))
      .rejects.toBeInstanceOf(UnsupportedApplicationReviewError)
    expect(requests).toHaveLength(1)
    requests = []
    responder = () => Response.json({ error: "Forbidden" }, { status: 403 })
    await expect(discoverApplicationReview(owner, { origin, workspaceId, definitionId, personId: "executor-1" }))
      .rejects.not.toBeInstanceOf(UnsupportedApplicationReviewError)
    requests = []
    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } }) : new Response("not JSON")
    await expect(readApplicationReview(owner, { origin, workspaceId, definitionId, integrationId, eventId })).rejects.toThrow()
    responder = request => request.url.endsWith("/v2/capabilities")
      ? Response.json({ version: 2, origin, applicationReview: { version: 1 } })
      : new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(384 * 1024 + 1)); controller.close() } }))
    await expect(readApplicationReview(owner, { origin, workspaceId, definitionId, integrationId, eventId })).rejects.toThrow(/size/i)
  })

  it("Given a captured request while capabilities are delayed, When caller mutates profile and body, Then signed request retains entry snapshot", async () => {
    let release!: (response: Response) => void
    let entered!: () => void
    const requested = new Promise<void>(resolve => { entered = resolve })
    const waiting = new Promise<Response>(resolve => { release = resolve })
    responder = request => request.url.endsWith("/v2/capabilities") ? (entered(), waiting) : Response.json({
      origin, workspaceId, definitionId, integrations: [{ integrationId, personId: "executor-1" }],
    })
    const profile = structuredClone(owner)
    const input = { origin, workspaceId, definitionId, personId: "executor-1" }
    const pending = discoverApplicationReview(profile, input)
    await requested
    input.workspaceId = "mutated-workspace"
    profile.identity.personId = "mutated-person"
    release(Response.json({ version: 2, origin, applicationReview: { version: 1 } }))
    await expect(pending).resolves.toEqual({ integrationId, personId: "executor-1" })
    await verifySentRequest(requests[1]!, "discover", { workspaceId, definitionId }, null)
  })

  it("Given a complete delegated device chain, When requesting review, Then carry and verify every certificate", async () => {
    const seed = await identitySeedFromPrivateKey(owner.privateKeys.identityPrivateKey!, owner.identity.personId)
    const issuer = await profileFromIdentitySeedForDevice(seed, "Review owner", new Uint8Array(32).fill(17))
    const child = await profileFromIdentitySeedForDevice(seed, "Review owner", new Uint8Array(32).fill(29))
    const leaf = await createDelegatedCertificate(issuer.privateKeys.devicePrivateKey, issuer.device.deviceId,
      owner.identity.personId, child.device.deviceId, child.device.publicKey, await certHashDefault(issuer.certificate))
    const delegated: LocalProfile = { ...child, certificate: leaf }
    await defaultProofStore.putCertificate("review-issuer", issuer.certificate)
    await writeLocal("tincanban.local_profile.v1", JSON.stringify({ identity: delegated.identity, device: delegated.device,
      certificate: leaf, privateKeys: { identityPrivateKeyPkcs8: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", delegated.privateKeys.identityPrivateKey!))),
        devicePrivateKeyPkcs8: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", delegated.privateKeys.devicePrivateKey))) } }))
    clearInMemoryProfileForReloadTest()
    const localDelegated = await bootstrapIdentity()
    await readApplicationReview(localDelegated, { origin, workspaceId, definitionId, integrationId, eventId })
    const request = requests.filter(value => value.body).at(-1)!
    const signed = request.body!.reviewRequest as Parameters<typeof verifyDeviceProofSignature>[0]
    expect(signed.certificates).toHaveLength(2)
    await verifyDeviceProofSignature(signed, owner.identity.personId, child.device.deviceId)
  })
})
