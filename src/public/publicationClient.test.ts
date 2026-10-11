import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import { publishBoardSnapshot, readPublicBoardManagementState, withdrawPublicBoard } from "./publicationClient"

const mocks = vi.hoisted(() => ({ projection: { kind: "tincanban-public-board", version: 1, board: { id: "public-fixture", title: "Published" }, columns: [], fields: [], cards: [], discussions: [], files: [] } }))
vi.mock("../domain/proofs", () => ({ defaultProofStore: { listCertificates: async () => [] }, certHashDefault: async () => "unused" }))
vi.mock("./publicProjection", () => ({ snapshotPublicBoardSource: (document: unknown) => document, createPublicBoardPublication: async () => ({ projection: mocks.projection, assets: [] }) }))

const origin = "https://keeper.example"
const boardId = "public-fixture"
const encoder = new TextEncoder()
type EnvelopePayload = Record<string, unknown> & { kind: string }
let owner: LocalProfile
let keeper: LocalProfile
let outsider: LocalProfile
let revision = 0
let withdrawn = false
let challengePatch: Record<string, unknown> = {}
let receiptPatch: Record<string, unknown> = {}
let forgeChallenge = false
let forgeReceipt = false
let snapshotHash = ""
let mutationCount = 0
let publicStatus = 404
const hash = (value: unknown) => sha256Base64Url(encoder.encode(canonicalizeJson(value)))

beforeAll(async () => {
  resetIdentityStorageForTest(); owner = await bootstrapIdentity("Publication owner")
  resetIdentityStorageForTest(); keeper = await bootstrapIdentity("Keeper signer")
  resetIdentityStorageForTest(); outsider = await bootstrapIdentity("Wrong signer")
})
beforeEach(async () => {
  revision = 0; withdrawn = false; challengePatch = {}; receiptPatch = {}; forgeChallenge = false; forgeReceipt = false; mutationCount = 0; publicStatus = 404
  snapshotHash = await hash(null)
  vi.stubGlobal("window", { location: { origin: "https://board.example" } })
  vi.stubGlobal("fetch", vi.fn(serve))
})
afterEach(() => vi.unstubAllGlobals())

async function signed(payload: EnvelopePayload, forged = false): Promise<SignedEnvelope<EnvelopePayload>> {
  return signEnvelope((forged ? outsider : keeper).privateKeys.devicePrivateKey, payload, keeper.device.deviceId, "RUSTY/2")
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }) }
async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (url.endsWith("/.well-known/mesh-lighthouse")) return json({ publicOrigin: origin, service: { serviceId: keeper.device.deviceId, publicKey: keeper.certificate.payload.devicePublicKey }, capabilities: { publicBoardPublication: { version: 1 } } })
  if (url.endsWith("/v1/public/challenges")) {
    const now = Date.now()
    return json({ challenge: await signed({ kind: "rusty-publication-challenge", version: 1, challengeId: "C".repeat(43), nonce: "N".repeat(43), serviceId: keeper.device.deviceId,
      publicOrigin: origin, boardId, personId: owner.identity.personId, deviceId: owner.device.deviceId, deviceKeyId: owner.device.deviceId,
      expectedRevision: revision, issuedAt: now, expiresAt: now + 120000, withdrawn, projectionHash: snapshotHash, ...challengePatch }, forgeChallenge) })
  }
  if (url.endsWith(`/v1/public/boards/${boardId}`) && init?.method === "PUT") {
    mutationCount++
    const request = JSON.parse(String(init.body)) as { authorization: SignedEnvelope<EnvelopePayload>; projection: unknown; action: string }
    expect(await verifyEnvelope(request.authorization, owner.certificate.payload.devicePublicKey, "MATCH/1")).toBe(true)
    const command = request.authorization.payload
    expect(command).toMatchObject({ serviceId: keeper.device.deviceId, publicOrigin: origin, boardId, expectedRevision: revision, projectionHash: await hash(request.projection) })
    return json(await signed({ kind: "rusty-publication-receipt", version: 1, serviceId: keeper.device.deviceId, boardId,
      controllerPersonId: owner.identity.personId, revision: revision + 1, action: request.action, projectionHash: await hash(request.projection),
      challengeId: command.challengeId, authorizationHash: await hash(request.authorization), withdrawn: request.action === "unpublish", ...receiptPatch }, forgeReceipt))
  }
  if (url.endsWith(`/v1/public/boards/${boardId}`)) return json(publicStatus === 404 ? { revision, withdrawn } : { boardId, revision, projection: mocks.projection, hash: snapshotHash }, publicStatus)
  throw new Error(`Unexpected publication request: ${url}`)
}
const publish = () => publishBoardSnapshot({ origin, boardId, workspaceId: "private-workspace", document: { entities: {} } as WorkspaceDocumentV2, profile: owner, action: "publish", expectedRevision: revision })

describe("publication client signed state and receipts", () => {
  it("Given a signed controller challenge, When withdrawing and republishing, Then the confirmed revision survives an anonymous 404", async () => {
    revision = 8; withdrawn = true
    expect(await readPublicBoardManagementState({ origin, boardId, profile: owner })).toMatchObject({ revision: 8, published: false })
    expect(await publish()).toMatchObject({ revision: 9, hash: await hash(mocks.projection) })
    revision = 9; withdrawn = false
    expect(await withdrawPublicBoard({ origin, boardId, profile: owner, expectedRevision: 9 })).toMatchObject({ revision: 10 })
  })
  it("Given a signed public status, When its anonymous content hash changes, Then integrity checking rejects the response", async () => {
    revision = 3; publicStatus = 200; snapshotHash = await hash(mocks.projection)
    expect(await readPublicBoardManagementState({ origin, boardId, profile: owner })).toMatchObject({ revision: 3, published: true })
    snapshotHash = await hash({ different: "content" })
    await expect(readPublicBoardManagementState({ origin, boardId, profile: owner })).rejects.toThrow(/integrity/i)
  })
  it.each(["serviceId", "publicOrigin", "boardId", "personId", "deviceId", "deviceKeyId", "challengeId", "nonce", "expectedRevision", "expiresAt"])("Given a signed challenge with wrong %s, When publishing, Then no mutation is sent", async field => {
    challengePatch[field] = ["expectedRevision", "expiresAt"].includes(field) ? -1 : "foreign-binding"
    await expect(publish()).rejects.toThrow(/challenge|binding/i)
    expect(mutationCount).toBe(0)
  })
  it("Given a challenge signed by a different key, When publishing, Then no mutation is sent", async () => {
    forgeChallenge = true
    await expect(publish()).rejects.toThrow(/signature/i)
    expect(mutationCount).toBe(0)
  })
  it.each(["serviceId", "boardId", "controllerPersonId", "revision", "action", "projectionHash", "challengeId", "authorizationHash", "withdrawn"])("Given a signed receipt with wrong %s, When publishing, Then success is rejected", async field => {
    receiptPatch[field] = field === "revision" ? 99 : field === "withdrawn" ? true : "wrong-receipt"
    await expect(publish()).rejects.toThrow(/receipt/i)
    expect(mutationCount).toBe(1)
  })
  it("Given an exact receipt signed by a different key, When publishing, Then success is rejected", async () => {
    forgeReceipt = true
    await expect(publish()).rejects.toThrow(/signature/i)
  })
})
