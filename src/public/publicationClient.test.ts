import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { bootstrapIdentity, canonicalizeJson, resetIdentityStorageForTest, sha256Base64Url, signEnvelope, verifyEnvelope, type LocalProfile, type SignedEnvelope } from "../domain/identity"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { snapshotPublicBoardSource } from "./publicProjection"
import { hasLocalPublicBoardChanges, publishBoardSnapshot, readPublicBoardManagementState, withdrawPublicBoard } from "./publicationClient"
import { RustyManagementRepository, type ManagementBinding } from "../sync/rustyManagementRepository"
import type { RustyManagementCapability } from "../sync/rustyManagementCapability"

const mocks = vi.hoisted(() => ({ projection: { kind: "tincanban-public-board", version: 1, board: { id: "public-fixture", title: "Published" }, columns: [], fields: [], cards: [], discussions: [], files: [] }, includeAsset: false, capturedSource: undefined as unknown }))
vi.mock("../domain/proofs", () => ({ defaultProofStore: { listCertificates: async () => [] }, certHashDefault: async () => "unused" }))
vi.mock("./publicProjection", async importOriginal => ({ ...await importOriginal<typeof snapshotPublicBoardSource>(),
  snapshotPublicBoardSource: (document: { entities?: Record<string, unknown> }, boardId: string) => structuredClone({ entities: document.entities?.[boardId] ? { [boardId]: document.entities[boardId] } : {} }) }))
vi.mock("../app/publicBoardPublication", () => ({ createBrowserBoardPublication: async (
  document: unknown,
) => {
  mocks.capturedSource = document
  return { projection: mocks.projection, assets: mocks.includeAsset ? [{ sha256: "F".repeat(43), bytes: new Uint8Array([1, 2, 3]) }] : [] }
} }))

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
let presentationVersion: number | undefined = 1
let scopeManagement = false
let managementCapability: SignedEnvelope<RustyManagementCapability> | null = null
let managementStatusCount = 0
let challengeBody: Record<string, unknown> | undefined
let mutationBody: Record<string, unknown> | undefined
let assetBody: Record<string, unknown> | undefined
let assetCount = 0
const hash = (value: unknown) => sha256Base64Url(encoder.encode(canonicalizeJson(value)))

beforeAll(async () => {
  resetIdentityStorageForTest(); owner = await bootstrapIdentity("Publication owner")
  resetIdentityStorageForTest(); keeper = await bootstrapIdentity("Keeper signer")
  resetIdentityStorageForTest(); outsider = await bootstrapIdentity("Wrong signer")
})
beforeEach(async () => {
  resetIdentityStorageForTest(); owner = await bootstrapIdentity("Publication owner")
  revision = 0; withdrawn = false; challengePatch = {}; receiptPatch = {}; forgeChallenge = false; forgeReceipt = false; mutationCount = 0; publicStatus = 404
  presentationVersion = 1; scopeManagement = false; managementCapability = null; managementStatusCount = 0; challengeBody = undefined; mutationBody = undefined; assetBody = undefined; assetCount = 0; mocks.includeAsset = false
  snapshotHash = await hash(null)
  vi.stubGlobal("window", { location: { origin: "https://board.example" } })
  vi.stubGlobal("fetch", vi.fn(serve))
})
afterEach(() => vi.unstubAllGlobals())

it("Given malformed or unsupported management advertisement, when reading publication status, then require upgrade instead of attempting legacy authorization", async () => {
  for (const scopeManagement of [null, { version: 2 }]) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ publicOrigin: origin,
      service: { serviceId: keeper.device.deviceId, publicKey: keeper.device.publicKey },
      capabilities: { publicBoardPublication: { version: 1 }, scopeManagement } })))
    await expect(readPublicBoardManagementState({ origin, boardId, profile: owner })).rejects.toThrow(/management|upgrade/i)
  }
  expect(challengeBody).toBeUndefined()
})

it("rechecks caller-supplied access before signing and after each publication request", async () => {
  const ensureCurrent = vi.fn()
  await publishBoardSnapshot({ origin, boardId, workspaceId: "private-workspace", document: { entities: {} } as WorkspaceDocumentV2,
    profile: owner, action: "publish", expectedRevision: revision, ensureCurrent })
  expect(ensureCurrent.mock.calls.length).toBeGreaterThan(4)
})

it("copies only selected-board source entities while keeping authority metadata separate", async () => {
  const board = { id: boardId, kind: "board" }
  const document = { entities: { [boardId]: board, private: { id: "private", kind: "board", uncloneable: () => "private" } } } as unknown as WorkspaceDocumentV2
  await publishBoardSnapshot({ origin, boardId, workspaceId: "private-workspace", document, profile: owner, action: "publish", expectedRevision: revision })
  expect(mocks.capturedSource).toEqual({ entities: { [boardId]: board } })
})

async function signed(payload: EnvelopePayload, forged = false): Promise<SignedEnvelope<EnvelopePayload>> {
  return signEnvelope((forged ? outsider : keeper).privateKeys.devicePrivateKey, payload, keeper.device.deviceId, "RUSTY/2")
}
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }) }
async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  if (url.endsWith("/.well-known/mesh-lighthouse")) return json({ publicOrigin: origin, service: { serviceId: keeper.device.deviceId, publicKey: keeper.certificate.payload.devicePublicKey }, capabilities: { publicBoardPublication: { version: 1, presentationVersion, fieldConfigurationVersion: 1 }, ...(scopeManagement ? { scopeManagement: { version: 1 } } : {}) } })
  if (url.endsWith(`/v2/management/board/${boardId}/status`)) {
    managementStatusCount++
    const request = JSON.parse(String(init?.body)) as { authorization: SignedEnvelope<EnvelopePayload> }
    const capabilityHash = managementCapability ? await hash(managementCapability) : null
    return json({ capability: managementCapability, migrationPending: false, receipt: await signed({
      kind: "rusty-management-policy-status-receipt", version: 1, serviceId: keeper.device.deviceId, origin,
      personId: owner.identity.personId, deviceId: owner.device.deviceId, resourceKind: "board", resourceId: boardId,
      requestId: request.authorization.payload.requestId as string, authorizationHash: await hash(request.authorization),
      capabilityHash, revision: managementCapability?.payload.revision ?? 0, migrationPending: false, issuedAt: Date.now(),
    }) })
  }
  if (url.endsWith("/v1/public/challenges")) {
    challengeBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    const now = Date.now()
    const sourceHeads = Array.isArray(challengeBody.sourceHeads) ? challengeBody.sourceHeads : []
    return json({ challenge: await signed({ kind: "rusty-publication-challenge", version: 1, challengeId: "C".repeat(43), nonce: "N".repeat(43), serviceId: keeper.device.deviceId,
      publicOrigin: origin, boardId, personId: owner.identity.personId, deviceId: owner.device.deviceId, deviceKeyId: owner.device.deviceId,
      expectedRevision: revision, issuedAt: now, expiresAt: now + 120000, withdrawn, projectionHash: snapshotHash,
      sourceHeadsHash: sourceHeads.length ? await hash(sourceHeads) : null, currentSourceHeads: [], ...challengePatch }, forgeChallenge) })
  }
  if (url.endsWith(`/v1/public/boards/${boardId}/files`)) {
    assetCount++
    const request = JSON.parse(String(init?.body)) as { authorization: SignedEnvelope<EnvelopePayload>; challenge: SignedEnvelope<EnvelopePayload>; sha256: string; byteLength: number }
    assetBody = request as unknown as Record<string, unknown>
    expect(await verifyEnvelope(request.authorization, owner.certificate.payload.devicePublicKey, "MATCH/1")).toBe(true)
    return json(await signed({ kind: "rusty-public-asset-receipt", version: 1, serviceId: keeper.device.deviceId, boardId,
      sha256: request.sha256, byteLength: request.byteLength, challengeId: request.challenge.payload.challengeId,
      authorizationHash: await hash(request.authorization) }))
  }
  if (url.endsWith(`/v1/public/boards/${boardId}`) && init?.method === "PUT") {
    mutationCount++
    const request = JSON.parse(String(init.body)) as { authorization: SignedEnvelope<EnvelopePayload>; projection: unknown; action: string }
    mutationBody = request as unknown as Record<string, unknown>
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
  it("compares the wire projection hash when optional presentation fields are undefined", async () => {
    const original = mocks.projection
    const projection = { ...mocks.projection, discussionAuthors: [{ id: "A".repeat(43), avatarData: undefined }] }
    mocks.projection = projection as typeof mocks.projection
    const wireProjection = JSON.parse(JSON.stringify(projection))
    await expect(hasLocalPublicBoardChanges({ document: { entities: {} } as WorkspaceDocumentV2, workspaceId: "private-workspace",
      boardId, hash: await hash(wireProjection) })).resolves.toBe(false)
    mocks.projection = original
  })
  it("Given an owner-approved projection with discussion and file bytes, When publishing, Then send that exact projection and asset manifest", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const assetHash = await sha256Base64Url(bytes)
    const approved = {
      kind: "tincanban-public-board" as const, version: 1 as const, board: { id: boardId, title: "Approved board", presentation: undefined },
      columns: [{ id: "todo", title: "To do", rank: "0/1" }], fields: [],
      cards: [{ id: "card", parentId: null, columnId: "todo", title: "Card", body: "", values: {}, rank: "0/1" }],
      discussions: [{ id: "note", threadId: "note", replyTo: null, targets: [{ type: "board" as const, id: boardId }], author: "Owner", body: "Approved discussion", createdAt: "2026-10-22T10:00:00Z" }],
      files: [{ id: "file", parentId: "card", title: "Attachment", fileName: "attachment.bin", mediaType: "application/octet-stream", byteLength: bytes.byteLength, sha256: assetHash }],
    }
    const wireApproved = JSON.parse(JSON.stringify(approved))
    const approvedHash = await hash(wireApproved)
    snapshotHash = approvedHash

    await publishBoardSnapshot({ origin, boardId, workspaceId: "private-workspace", document: { entities: {} } as WorkspaceDocumentV2,
      profile: owner, action: "publish", expectedRevision: revision, preparedProjection: approved,
      preparedProjectionHash: approvedHash, preparedAssetManifest: [{ sha256: assetHash, byteLength: bytes.byteLength }],
      preparedAssets: [{ sha256: assetHash, bytes }] })

    expect(mutationBody?.projection).toEqual(wireApproved)
    expect(((mutationBody?.authorization as SignedEnvelope<EnvelopePayload>).payload).projectionHash).toBe(approvedHash)
    expect(assetBody).toMatchObject({ sha256: assetHash, byteLength: bytes.byteLength })
    expect(assetCount).toBe(1)
  })
  it("Given migrated board-management authority, When publishing, Then send exact capability and signed revision on the challenge and command", async () => {
    scopeManagement = true
    const serviceId = keeper.device.deviceId
    managementCapability = await signed({ kind: "rusty-scope-management-capability", version: 1, serviceId, origin,
      personId: owner.identity.personId, resourceKind: "board", resourceId: boardId, revision: 4,
      operations: ["management.update", "publication.publish"], revokedDeviceIds: [], requestId: "policy-4",
      authorizationHash: "A".repeat(43), issuedAt: Date.now() }) as SignedEnvelope<RustyManagementCapability>
    await expect(publish()).resolves.toMatchObject({ revision: 1 })
    expect(managementStatusCount).toBe(1)
    expect(challengeBody?.managementCapability).toEqual(managementCapability)
    expect(mutationBody?.managementCapability).toEqual(managementCapability)
    expect((mutationBody?.authorization as SignedEnvelope<EnvelopePayload>).payload.managementRevision).toBe(4)
  })
  it("Given migrated board-management authority, When reading publication status, Then send status capability on the controller challenge", async () => {
    scopeManagement = true
    managementCapability = await signed({ kind: "rusty-scope-management-capability", version: 1, serviceId: keeper.device.deviceId, origin,
      personId: owner.identity.personId, resourceKind: "board", resourceId: boardId, revision: 3,
      operations: ["management.update", "publication.status"], revokedDeviceIds: [], requestId: "policy-3",
      authorizationHash: "A".repeat(43), issuedAt: Date.now() }) as SignedEnvelope<RustyManagementCapability>
    await expect(readPublicBoardManagementState({ origin, boardId, profile: owner })).resolves.toMatchObject({ revision: 0, published: false })
    expect(managementStatusCount).toBe(1)
    expect(challengeBody?.managementCapability).toEqual(managementCapability)
  })
  it("Given a managed update or withdrawal, When requested, Then use matching signed operation and revision", async () => {
    scopeManagement = true
    managementCapability = await signed({ kind: "rusty-scope-management-capability", version: 1, serviceId: keeper.device.deviceId, origin,
      personId: owner.identity.personId, resourceKind: "board", resourceId: boardId, revision: 6,
      operations: ["management.update", "publication.unpublish", "publication.update"], revokedDeviceIds: [], requestId: "policy-6",
      authorizationHash: "A".repeat(43), issuedAt: Date.now() }) as SignedEnvelope<RustyManagementCapability>
    await publishBoardSnapshot({ origin, boardId, workspaceId: "private-workspace", document: { entities: {} } as WorkspaceDocumentV2,
      profile: owner, action: "update", expectedRevision: revision })
    expect((mutationBody?.authorization as SignedEnvelope<EnvelopePayload>).payload).toMatchObject({ action: "update", managementRevision: 6 })
    await withdrawPublicBoard({ origin, boardId, profile: owner, expectedRevision: revision })
    expect((mutationBody?.authorization as SignedEnvelope<EnvelopePayload>).payload).toMatchObject({ action: "unpublish", managementRevision: 6 })
  })
  it("Given advertised management with no migrated capability, When publishing, Then keep legacy compatibility without creating policy", async () => {
    scopeManagement = true
    await expect(publish()).resolves.toMatchObject({ revision: 1 })
    expect(managementStatusCount).toBe(1)
    expect(challengeBody?.managementCapability).toBeUndefined()
    expect(mutationBody?.managementCapability).toBeUndefined()
    expect((mutationBody?.authorization as SignedEnvelope<EnvelopePayload>).payload.managementRevision).toBeUndefined()
  })
  it("Given policy changes while a challenge is in flight, When publication resumes, Then do not sign or send under the stale capability", async () => {
    scopeManagement = true
    const serviceId = keeper.device.deviceId
    managementCapability = await signed({ kind: "rusty-scope-management-capability", version: 1, serviceId, origin,
      personId: owner.identity.personId, resourceKind: "board", resourceId: boardId, revision: 4,
      operations: ["management.update", "publication.publish"], revokedDeviceIds: [], requestId: "policy-4",
      authorizationHash: "A".repeat(43), issuedAt: Date.now() }) as SignedEnvelope<RustyManagementCapability>
    let challengeArrived!: () => void
    const arrived = new Promise<void>(resolve => { challengeArrived = resolve })
    let releaseChallenge!: () => void
    const challengePaused = new Promise<void>(resolve => { releaseChallenge = resolve })
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await serve(input, init)
      if (String(input).endsWith("/v1/public/challenges")) { challengeArrived(); await challengePaused }
      return response
    }))
    const pending = publish()
    await arrived
    const changedPolicy = await signed({ ...managementCapability.payload, revision: 5, requestId: "policy-5",
      operations: ["management.update"] }) as SignedEnvelope<RustyManagementCapability>
    const binding: ManagementBinding = { origin, servicePublicKey: keeper.certificate.payload.devicePublicKey, resourceKind: "board", resourceId: boardId }
    await new RustyManagementRepository(owner.identity.personId).observe(binding, changedPolicy)
    releaseChallenge()
    await expect(pending).rejects.toThrow(/stale|authority/i)
    expect(mutationCount).toBe(0)
  })
  it("Given migrated authority with file staging rights, When publishing attachments, Then bind capability and revision to the stage request", async () => {
    scopeManagement = true
    mocks.includeAsset = true
    const serviceId = keeper.device.deviceId
    managementCapability = await signed({ kind: "rusty-scope-management-capability", version: 1, serviceId, origin,
      personId: owner.identity.personId, resourceKind: "board", resourceId: boardId, revision: 5,
      operations: ["management.update", "publication.publish", "publication.stage-file"], revokedDeviceIds: [], requestId: "policy-5",
      authorizationHash: "A".repeat(43), issuedAt: Date.now() }) as SignedEnvelope<RustyManagementCapability>
    await publish()
    expect(assetCount).toBe(1)
    expect(challengeBody?.managementCapability).toEqual(managementCapability)
    expect(assetBody?.managementCapability).toEqual(managementCapability)
    expect(((assetBody?.authorization as SignedEnvelope<EnvelopePayload>).payload).managementRevision).toBe(5)
  })
  it("Given migrated authority without file-staging rights, When publishing attachments, Then reject before requesting a stage challenge", async () => {
    scopeManagement = true
    mocks.includeAsset = true
    const serviceId = keeper.device.deviceId
    managementCapability = await signed({ kind: "rusty-scope-management-capability", version: 1, serviceId, origin,
      personId: owner.identity.personId, resourceKind: "board", resourceId: boardId, revision: 5,
      operations: ["management.update", "publication.publish"], revokedDeviceIds: [], requestId: "policy-5",
      authorizationHash: "A".repeat(43), issuedAt: Date.now() }) as SignedEnvelope<RustyManagementCapability>
    await expect(publish()).rejects.toThrow()
    expect(assetCount).toBe(0)
    expect(mutationCount).toBe(0)
  })
  it("Given legacy discovery but locally stored managed policy, When publishing, Then require service upgrade instead of legacy fallback", async () => {
    const binding: ManagementBinding = { origin, servicePublicKey: keeper.certificate.payload.devicePublicKey, resourceKind: "board", resourceId: boardId }
    const serviceId = keeper.device.deviceId
    const cap = await signed({ kind: "rusty-scope-management-capability", version: 1, serviceId, origin,
      personId: owner.identity.personId, resourceKind: "board", resourceId: boardId, revision: 4,
      operations: ["management.update", "publication.publish"], revokedDeviceIds: [], requestId: "policy-4",
      authorizationHash: "A".repeat(43), issuedAt: Date.now() }) as SignedEnvelope<RustyManagementCapability>
    await new RustyManagementRepository(owner.identity.personId).observe(binding, cap)
    await expect(publish()).rejects.toThrow(/upgrade/i)
    expect(challengeBody).toBeUndefined()
    expect(mutationCount).toBe(0)
  })
  it("Given the wrong private key, when publishing, then no mutation is sent", async () => {
    const mismatched = { ...owner, privateKeys: { devicePrivateKey: outsider.privateKeys.devicePrivateKey } }
    await expect(publishBoardSnapshot({ origin, boardId, workspaceId: "private-workspace", document: { entities: {} } as WorkspaceDocumentV2,
      profile: mismatched, action: "publish", expectedRevision: revision })).rejects.toThrow()
    expect(mutationCount).toBe(0)
  })
  it("Given identity switches while obtaining a challenge, when publishing resumes, then no old-identity mutation is sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await serve(input, init)
      if (String(input).endsWith("/v1/public/challenges")) {
        resetIdentityStorageForTest(); await bootstrapIdentity("Replacement identity")
      }
      return response
    }))
    await expect(publish()).rejects.toThrow(/identity|stale/)
    expect(mutationCount).toBe(0)
  })
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

  it("Given a challenge bound to another source frontier, When publishing, Then reject before signing or mutation", async () => {
    challengePatch = { sourceHeadsHash: "C".repeat(43) }
    await expect(publish()).rejects.toThrow(/source frontier/i)
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

it("Given an older publication service, When publishing visitor presentation, Then require upgrade before uploading files or changing a snapshot", async () => {
  presentationVersion = undefined
  await expect(publish()).rejects.toThrow(/upgrade.*visitor presentation/i)
  expect(assetCount).toBe(0)
  expect(mutationCount).toBe(0)
  await expect(readPublicBoardManagementState({ origin, boardId, profile: owner })).resolves.toMatchObject({ published: false })
})
