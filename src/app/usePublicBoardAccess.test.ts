import { effectScope, nextTick, ref, shallowRef } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePublicBoardAccess } from "./usePublicBoardAccess"
import { createWorkspaceDoc } from "../test/boardFixture"
import { canonicalizeJson, sha256Base64Url } from "../domain/identity"
import { parsePublicationRecord, publicationRecordKey } from "../domain/publicationState"
import type { WorkspaceDocumentV2 } from "../domain/model"
import type { PublicBoardPublication } from "../public/publicProjection"
import { createBrowserBoardPublication } from "./publicBoardPublication"
import type * as PublicationClient from "../public/publicationClient"

const mocks = vi.hoisted(() => {
  const local = new Map<string, string>()
  return {
  read: vi.fn(), compare: vi.fn(), publish: vi.fn(), withdraw: vi.fn(),
  buildPolicy: vi.fn(), policyHash: vi.fn(), policyContentHash: vi.fn(),
  chatRevision: vi.fn(),
  chat: vi.fn(), attachment: vi.fn(),
  readLocal: vi.fn(async (key: string) => local.get(key) ?? null),
  writeLocal: vi.fn(async (key: string, value: string) => { local.set(key, value) }),
  clearLocal: () => local.clear(),
  useActualPublication: false,
  preparedAssets: [] as Array<{ sha256: string; bytes: Uint8Array }>,
  }
})
vi.mock("../chat/service", () => ({ readChatContentRevision: mocks.chatRevision, getChatScope: async () => "chat-scope", loadChat: mocks.chat }))
vi.mock("../attachments", () => ({ readAttachment: mocks.attachment }))
vi.mock("../localDb", async importOriginal => ({ ...await importOriginal(),
  readLocal: mocks.readLocal, writeLocal: mocks.writeLocal, deleteLocal: async (key: string) => { await mocks.writeLocal(key, "") } }))
vi.mock("./publicBoardPublication", async importOriginal => {
  const actual = await importOriginal() as { createBrowserBoardPublication: (document: WorkspaceDocumentV2, workspaceId: string, boardId: string) => Promise<PublicBoardPublication> }
  return { createBrowserBoardPublication: async (document: unknown, workspaceId: string, boardId: string) => mocks.useActualPublication
    ? actual.createBrowserBoardPublication(document as never, workspaceId, boardId)
    : { projection: { kind: "test-public-board", workspaceId, board: { id: boardId }, cards: [] }, assets: mocks.preparedAssets } }
})
vi.mock("../public/publicationClient", () => ({
  readPublicBoardManagementState: mocks.read,
  hasLocalPublicBoardChanges: mocks.compare,
  publishBoardSnapshot: mocks.publish,
  withdrawPublicBoard: mocks.withdraw,
}))
vi.mock("../public/publicDeliveryPolicy", () => ({
  buildPublicBoardDeliveryPolicy: mocks.buildPolicy,
  publicBoardDeliveryPolicyHash: mocks.policyHash,
  publicBoardDeliveryPolicyContentHash: mocks.policyContentHash,
}))

describe("public board owner access", () => {
  type ProfileFixture = { identity: { personId: string; publicKey?: string; name?: string }; device: { deviceId: string; publicKey?: string }; certificate?: { signature: string } }
  let scope = effectScope()
  let boardId = ref("board-a")
  let workspaceId = ref("workspace-a")
  let sourceVersion = ref(1)
  let sourceHeads = ref(["head-a"])
  let isOwner = ref(true)
  let document = shallowRef({ entities: {} })
  let profile = ref<ProfileFixture>({ identity: { personId: "person-a" }, device: { deviceId: "device-a" } })

  beforeEach(() => {
    mocks.clearLocal()
    mocks.useActualPublication = false
    mocks.preparedAssets = []
    vi.useFakeTimers()
    scope = effectScope()
    boardId = ref("board-a")
    workspaceId = ref("workspace-a")
    sourceVersion = ref(1)
    sourceHeads = ref(["head-a"])
    isOwner = ref(true)
    document = shallowRef({ entities: {} })
    profile = ref<ProfileFixture>({ identity: { personId: "person-a" }, device: { deviceId: "device-a" } })
    mocks.read.mockReset().mockResolvedValue({ revision: 4, published: true, hash: "projection-hash", deliveryGeneration: 1, deliveryPolicyHash: "policy-hash" })
    mocks.compare.mockReset().mockResolvedValue(false)
    mocks.publish.mockReset().mockResolvedValue({ revision: 5, hash: "next-hash", url: "https://app.test/boards/board-a" })
    mocks.withdraw.mockReset().mockResolvedValue({ revision: 5, url: "https://app.test/boards/board-a" })
    mocks.buildPolicy.mockReset().mockImplementation(async (_profile, workspaceId, boardId, generation) => ({
      policy: { payload: { workspaceId, boardId, generation } }, ownerCertificates: [],
    }))
    mocks.policyHash.mockReset().mockResolvedValue("policy-hash")
    mocks.policyContentHash.mockReset().mockResolvedValue("policy-content-hash")
    mocks.chatRevision.mockReset().mockResolvedValue("chat-revision-1")
    mocks.chat.mockReset().mockResolvedValue({ messages: [], profiles: [] })
    mocks.attachment.mockReset().mockResolvedValue(new TextEncoder().encode("public file"))
  })
  afterEach(() => { scope.stop(); vi.useRealTimers() })

  function create() {
    return scope.run(() => usePublicBoardAccess({
      origin: "https://rusty.test", boardId: () => boardId.value, boardTitle: () => "Board A", workspaceId: () => workspaceId.value,
      sourceVersion: () => sourceVersion.value, document: () => document.value as never,
      sourceHeads: () => sourceHeads.value,
      owner: () => isOwner.value, profile: () => profile.value as never, debounceMs: 20,
    }))!
  }

  it("updates a changed projection automatically and skips an unchanged projection", async () => {
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(1))
    mocks.compare.mockClear()
    mocks.compare.mockResolvedValueOnce(false)
    sourceHeads.value = ["head-b"]
    sourceVersion.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(1))
    expect(mocks.publish).not.toHaveBeenCalled()
    mocks.compare.mockResolvedValueOnce(true)
    sourceHeads.value = ["head-c"]
    sourceVersion.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))
    expect(mocks.publish.mock.calls[0]?.[0]).toMatchObject({ action: "update", expectedRevision: 4 })
    expect(mocks.publish.mock.calls[0]?.[0].deliveryPolicy).toBeUndefined()
  })

  it("skips attachment rechecks after an identity presentation refresh with unchanged board heads", async () => {
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.compare).toHaveBeenCalledOnce())
    mocks.compare.mockClear()

    sourceVersion.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(20)

    expect(sourceHeads.value).toEqual(["head-a"])
    expect(mocks.compare).not.toHaveBeenCalled()
  })

  it("Given a confirmed publication, when Rusty loses its record, then retain owner intent and require recovery without republishing", async () => {
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))

    mocks.read.mockResolvedValue({ revision: 0, published: false, availability: "missing", hash: "" })
    await access.refresh()

    expect(access.published.value).toBe(true)
    expect(access.recoveryNeeded.value).toBe(true)
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it("Given a publish request, when effects start, then its snapshot and hash are already durable and its verified receipt is retained", async () => {
    mocks.read.mockResolvedValue({ revision: 0, published: false, availability: "missing", hash: "" })
    const asset = { sha256: "approved-file-hash", bytes: new Uint8Array([4, 5, 6]) }
    mocks.preparedAssets = [asset]
    const receipt = { signerKeyId: "service-a", signature: "signed-receipt", payload: { kind: "rusty-publication-receipt", revision: 1 } }
    const key = publicationRecordKey("https://rusty.test", "workspace-a", "board-a", profile.value as never)
    mocks.publish.mockImplementationOnce(async (input: { preparedProjection: unknown; preparedAssets: Array<{ sha256: string; bytes: Uint8Array }> }) => {
      const beforeEffect = parsePublicationRecord(await mocks.readLocal(key))
      expect(beforeEffect?.intent).toMatchObject({ action: "publish", expectedRevision: 0 })
      expect(beforeEffect?.intent?.confirmed).toBeUndefined()
      expect(beforeEffect?.intent?.projection).toEqual(input.preparedProjection)
      expect(beforeEffect?.intent?.projectionHash).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(beforeEffect?.intent?.preparedAssetManifest).toEqual([{ sha256: asset.sha256, byteLength: asset.bytes.byteLength }])
      expect(input.preparedAssets).toEqual([asset])
      return { revision: 1, hash: beforeEffect!.intent!.projectionHash, url: "https://app.test/boards/board-a", receipt }
    })

    const access = create()
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))
    await access.setPublic(true)

    const saved = parsePublicationRecord(await mocks.readLocal(key))
    expect(saved).toMatchObject({ ownerIntent: "published", confirmedRevision: 1, receipt, intent: { action: "publish", confirmed: true } })
  })

  it("Given first publication aborts before remote creation, when status confirms absence, then stay private until a fresh owner confirmation", async () => {
    mocks.read.mockResolvedValue({ revision: 0, published: false, availability: "missing", hash: "" })
    mocks.publish.mockRejectedValueOnce(new Error("Board source changed during publication preparation"))
    const access = create()
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))

    await expect(access.setPublic(true)).rejects.toThrow("Board source changed during publication preparation")
    const key = publicationRecordKey("https://rusty.test", "workspace-a", "board-a", profile.value as never)
    expect(parsePublicationRecord(await mocks.readLocal(key))?.intent?.confirmed).toBeUndefined()

    await access.refresh()
    expect(access.published.value).toBe(false)
    expect(access.withdrawn.value).toBe(false)
    expect(access.recoveryNeeded.value).toBe(false)
    expect(parsePublicationRecord(await mocks.readLocal(key))).toMatchObject({ ownerIntent: "published", remoteAvailability: "missing" })
    expect(parsePublicationRecord(await mocks.readLocal(key))?.intent).toBeUndefined()

    await access.setPublic(true)
    expect(mocks.publish).toHaveBeenCalledTimes(2)
    expect(access.published.value).toBe(true)
  })

  it("Given publication preparation is pending, When a newer admitted source replaces it, Then discard stale preparation and publish current heads without delivery-failure backoff", async () => {
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.compare).toHaveBeenCalledOnce())
    let finishComparison!: (changed: boolean) => void
    mocks.compare.mockImplementationOnce(() => new Promise(resolve => { finishComparison = resolve })).mockResolvedValue(true)
    sourceHeads.value = ["head-b"]
    sourceVersion.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(2))
    const current = { entities: { body: "Current admitted content" } }
    document.value = current
    sourceHeads.value = ["head-c"]
    sourceVersion.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(20)
    finishComparison(true)
    await vi.advanceTimersByTimeAsync(20)
    expect(access.error.value).toBe("")
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce())
    expect(mocks.publish.mock.calls[0]?.[0]).toMatchObject({ document: current, sourceHeads: ["head-c"], action: "update", expectedRevision: 4 })
    expect(access.error.value).toBe("")
    expect(access.revision.value).toBe(5)
  })

  it("advances policy generation only when the verified grant fingerprint changes", async () => {
    mocks.read.mockResolvedValue({ revision: 4, published: true, hash: "projection-hash", deliveryGeneration: 2, deliveryPolicyHash: "stored-policy" })
    mocks.policyHash.mockResolvedValueOnce("changed-policy").mockResolvedValueOnce("changed-policy")
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))
    expect(mocks.buildPolicy.mock.calls.map(call => call[3])).toEqual([2, 3])
    expect(mocks.buildPolicy.mock.calls.every(call => call[5] === document.value)).toBe(true)
    expect(mocks.publish.mock.calls[0]?.[0].deliveryPolicy.policy.payload.generation).toBe(3)
  })

  it("Given unchanged policy content with a randomized signature, when periodic owner status refreshes, then create no new publication or policy generation", async () => {
    mocks.read.mockResolvedValue({ revision: 3, published: true, hash: "projection-hash", deliveryGeneration: 1,
      deliveryPolicyHash: "server-signature-hash", deliveryPolicyContentHash: "policy-content-hash" })
    mocks.policyHash.mockResolvedValue("another-signature-hash")
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.buildPolicy).toHaveBeenCalledOnce())
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(20)
    expect(mocks.buildPolicy).toHaveBeenCalledTimes(2)
    expect(mocks.compare).toHaveBeenCalledOnce()
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(access.revision.value).toBe(3)
  })

  it("Given unchanged board heads, when persisted chat changes or server projection changes, then compare the visitor projection again", async () => {
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    await vi.advanceTimersByTimeAsync(20)
    expect(mocks.compare).toHaveBeenCalledOnce()
    mocks.chatRevision.mockResolvedValue("chat-revision-2")
    await vi.advanceTimersByTimeAsync(15_020)
    expect(mocks.compare).toHaveBeenCalledTimes(2)
    mocks.read.mockResolvedValue({ revision: 6, published: true, hash: "remote-projection-hash", deliveryGeneration: 1, deliveryPolicyHash: "policy-hash" })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.compare).toHaveBeenCalledTimes(3)
  })

  it("Given a published static board with a verified attachment, when repeated owner polls run, then read attachment bytes and full chat only during the first comparison", async () => {
    const doc = createWorkspaceDoc("workspace-a", "Published", "person-a", "blank")
    const board = Object.values(doc.entities).find(entity => "kind" in entity && entity.kind === "board")!
    Object.assign(doc.entities, { file: { id: "file", kind: "document", title: "Handout", documentKind: "file", format: "plain", content: null,
      file: { type: "blob", sha256: "digest", byteLength: 11, mimeType: "text/plain", fileName: "handout.txt" },
      placement: { parentId: board.id, rank: "1/1" }, archivedAt: null } })
    document.value = doc as never
    boardId.value = board.id
    mocks.useActualPublication = true
    const { projection } = await createBrowserBoardPublication(doc, doc.id, board.id)
    const wireProjection = JSON.parse(JSON.stringify(projection))
    const hash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(wireProjection)))
    mocks.chat.mockClear(); mocks.attachment.mockClear()
    const actual = await vi.importActual<typeof PublicationClient>("../public/publicationClient")
    mocks.compare.mockImplementation(actual.hasLocalPublicBoardChanges)
    mocks.read.mockResolvedValue({ revision: 4, published: true, hash, deliveryGeneration: 1, deliveryPolicyHash: "policy-hash" })
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.compare).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(access.busy.value).toBe(false))
    expect(access.error.value).toBe("")
    await vi.advanceTimersByTimeAsync(45_020)
    expect(mocks.read).toHaveBeenCalledTimes(4)
    expect(mocks.compare).toHaveBeenCalledOnce()
    expect(mocks.chat).toHaveBeenCalledOnce()
    expect(mocks.attachment).toHaveBeenCalledOnce()
    mocks.useActualPublication = false
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it("Given changed signed policy content, when syncing, then advance its generation even if the projected board is unchanged", async () => {
    mocks.read.mockResolvedValue({ revision: 3, published: true, hash: "projection-hash", deliveryGeneration: 1,
      deliveryPolicyHash: "server-signature-hash", deliveryPolicyContentHash: "previous-content-hash" })
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce())
    expect(mocks.publish.mock.calls[0]?.[0].deliveryPolicy.policy.payload.generation).toBe(2)
  })

  it("Given an existing public board without delivery policy, when its owner refreshes the same source, then adopt policy in place without rebuilding the visitor board", async () => {
    mocks.read.mockResolvedValue({ revision: 4, published: true, hash: "projection-hash", deliveryGeneration: null, deliveryPolicyHash: null })
    mocks.compare.mockResolvedValue(false)
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))

    expect(mocks.compare).toHaveBeenCalledTimes(1)
    expect(mocks.publish.mock.calls[0]?.[0]).toMatchObject({ action: "update", expectedRevision: 4, boardId: "board-a" })
    expect(mocks.publish.mock.calls[0]?.[0].deliveryPolicy.policy.payload).toMatchObject({
      workspaceId: "workspace-a", boardId: "board-a", generation: 1,
    })
    expect(mocks.publish.mock.calls[0]?.[0].document).toBe(document.value)
    expect(access.published.value).toBe(true)
    expect(access.revision.value).toBe(5)
  })

  it("withdraws explicitly and never republishes after a later source edit", async () => {
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(1))
    mocks.publish.mockClear()
    await access.setPublic(false)
    sourceVersion.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(40)
    expect(mocks.withdraw).toHaveBeenCalledTimes(1)
    expect(mocks.publish).not.toHaveBeenCalled()
    expect(access.published.value).toBe(false)
    mocks.read.mockResolvedValue({ revision: 0, published: false, availability: "missing", hash: "" })
    await access.refresh()
    expect(access.published.value).toBe(false)
    expect(access.withdrawn.value).toBe(true)
    expect(access.recoveryNeeded.value).toBe(false)
  })

  it("Given an explicit withdrawal with uncertain remote outcome, when Rusty later reports a missing record, then do not restore publication intent", async () => {
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    mocks.withdraw.mockRejectedValueOnce(new Error("response lost"))
    await expect(access.setPublic(false)).rejects.toThrow("response lost")

    mocks.read.mockResolvedValue({ revision: 0, published: false, availability: "missing", hash: "" })
    await access.refresh()

    expect(access.published.value).toBe(false)
    expect(access.withdrawn.value).toBe(true)
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it("shows capture failures from a public access change instead of silently dismissing confirmation", async () => {
    mocks.read.mockResolvedValue({ revision: 0, published: false, hash: "" })
    const access = create()
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))
    document.value = null as never

    await expect(access.setPublic(true)).rejects.toThrow("Current owner, board, or workspace data is unavailable")
    expect(access.error.value).toBe("Current owner, board, or workspace data is unavailable")
    expect(mocks.publish).not.toHaveBeenCalled()
  })

  it("Given an owner status request in flight, when board content changes, then accept the signed status for the same board and owner", async () => {
    let finishRead!: (value: { revision: number; published: boolean }) => void
    mocks.read.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    const access = create()
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce())
    sourceVersion.value++
    await nextTick()
    finishRead({ revision: 0, published: false })
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))
    expect(access.error.value).toBe("")
    expect(access.published.value).toBe(false)
    expect(mocks.read).toHaveBeenCalledOnce()
  })

  it("Given publication in flight, when board content changes, then reject its stale snapshot instead of marking it published", async () => {
    mocks.read.mockResolvedValue({ revision: 0, published: false })
    let finishPublish!: (value: { revision: number; hash: string; url: string }) => void
    mocks.publish.mockImplementationOnce(() => new Promise(resolve => { finishPublish = resolve }))
    const access = create()
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))
    const operation = access.setPublic(true)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce())
    sourceHeads.value = ["head-b"]
    sourceVersion.value++
    await nextTick()
    finishPublish({ revision: 1, hash: "stale", url: "https://app.test/boards/board-a" })
    await expect(operation).rejects.toThrow(/changed/)
    expect(access.published.value).toBe(false)
  })

  it("Given publication in flight, when identity presentation refreshes without changing board heads, then keep the current publication", async () => {
    mocks.read.mockResolvedValue({ revision: 0, published: false })
    let finishPublish!: (value: { revision: number; hash: string; url: string }) => void
    mocks.publish.mockImplementationOnce(() => new Promise(resolve => { finishPublish = resolve }))
    const access = create()
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))
    const operation = access.setPublic(true)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce())
    // refreshIdentity invalidates state projections even when the admitted CRDT is unchanged.
    profile.value.identity.name = "Updated display name"
    sourceVersion.value++
    await nextTick()
    finishPublish({ revision: 1, hash: "current", url: "https://app.test/boards/board-a" })
    await expect(operation).resolves.toBeUndefined()
    expect(access.published.value).toBe(true)
    expect(access.revision.value).toBe(1)
    expect(access.error.value).toBe("")
  })

  it.each(["identity key", "device key", "certificate"])("Given publication in flight, when the same owner's %s changes, then reject captured authority even without a projection invalidation", async field => {
    mocks.read.mockResolvedValue({ revision: 0, published: false })
    let finishPublish!: (value: { revision: number; hash: string; url: string }) => void
    mocks.publish.mockImplementationOnce(() => new Promise(resolve => { finishPublish = resolve }))
    const access = create()
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))
    const operation = access.setPublic(true)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce())
    if (field === "identity key") profile.value.identity.publicKey = "replacement-identity-key"
    else if (field === "device key") profile.value.device.publicKey = "replacement-device-key"
    else profile.value.certificate = { signature: "replacement-certificate" }
    finishPublish({ revision: 1, hash: "stale", url: "https://app.test/boards/board-a" })
    await expect(operation).rejects.toThrow(/owner identity changed/)
    expect(access.published.value).toBe(false)
  })

  it("Given publication in flight, when admitted heads change without a projection invalidation, then reject the stale snapshot", async () => {
    mocks.read.mockResolvedValue({ revision: 0, published: false })
    let finishPublish!: (value: { revision: number; hash: string; url: string }) => void
    mocks.publish.mockImplementationOnce(() => new Promise(resolve => { finishPublish = resolve }))
    const access = create()
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))
    const operation = access.setPublic(true)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce())
    sourceHeads.value = ["head-b"]
    finishPublish({ revision: 1, hash: "stale", url: "https://app.test/boards/board-a" })
    await expect(operation).rejects.toThrow("Board source changed during publication preparation")
    expect(access.published.value).toBe(false)
  })

  it("rejects management actions after owner, board or profile changes", async () => {
    mocks.read.mockResolvedValue({ revision: 4, published: false, hash: "" })
    let finishPublish!: (value: { revision: number; hash: string; url: string }) => void
    mocks.publish.mockImplementation(() => new Promise(resolve => { finishPublish = resolve }))
    const access = create()
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))
    const publish = access.setPublic(true)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))
    profile.value = { identity: { personId: "person-b" }, device: { deviceId: "device-b" } }
    finishPublish({ revision: 5, hash: "new", url: "https://app.test/boards/board-a" })
    await expect(publish).rejects.toThrow(/identity changed|no longer current/)
  })

  it("Given a withdrawn board, when its owner enables public access again, then advance the retained delivery policy generation", async () => {
    mocks.read.mockResolvedValue({ revision: 8, published: false, hash: "", deliveryGeneration: 3, deliveryPolicyHash: "old-policy" })
    const access = create()
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))
    await access.setPublic(true)
    expect(mocks.buildPolicy.mock.calls[0]?.[3]).toBe(4)
    expect(mocks.publish.mock.calls[0]?.[0]).toMatchObject({ action: "publish", expectedRevision: 8 })
    expect(access.published.value).toBe(true)
  })

  it("cancels an in-flight owner mutation when its scope is disposed", async () => {
    mocks.read.mockResolvedValue({ revision: 4, published: false, hash: "" })
    let finishPublish!: (value: { revision: number; hash: string; url: string }) => void
    mocks.publish.mockImplementation(() => new Promise(resolve => { finishPublish = resolve }))
    const access = create()
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))
    const operation = access.setPublic(true)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))
    scope.stop()
    finishPublish({ revision: 5, hash: "new", url: "https://app.test/boards/board-a" })
    await expect(operation).rejects.toThrow(/no longer current|changed/)
    expect(access.published.value).toBe(false)
  })

  it("rejects a captured owner operation after authority flips away and back", async () => {
    mocks.read.mockResolvedValue({ revision: 4, published: false, hash: "" })
    let finishPublish!: (value: { revision: number; hash: string; url: string }) => void
    mocks.publish.mockImplementation(() => new Promise(resolve => { finishPublish = resolve }))
    const access = create()
    await vi.waitFor(() => expect(access.checked.value && !access.busy.value).toBe(true))
    const operation = access.setPublic(true)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))
    isOwner.value = false
    await nextTick()
    isOwner.value = true
    await nextTick()
    finishPublish({ revision: 5, hash: "new", url: "https://app.test/boards/board-a" })
    await expect(operation).rejects.toThrow(/no longer current/)
  })

  it("Given a publication outcome is uncertain and status advanced, then keep its saved intent instead of replacing it", async () => {
    mocks.read.mockResolvedValueOnce({ revision: 4, published: true, hash: "old", deliveryGeneration: 1, deliveryPolicyHash: "policy-hash" })
      .mockResolvedValueOnce({ revision: 7, published: true, hash: "latest", deliveryGeneration: 1, deliveryPolicyHash: "policy-hash" })
    mocks.compare.mockResolvedValue(true)
    mocks.publish.mockRejectedValueOnce(new Error("revision conflict"))
      .mockResolvedValueOnce({ revision: 8, hash: "next", url: "https://app.test/boards/board-a" })
    const access = create()
    await vi.waitFor(() => expect(access.published.value && !access.busy.value).toBe(true))
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))

    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.publish).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_900)
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(20)
    expect(mocks.publish).toHaveBeenCalledOnce()
    expect(access.error.value).toMatch(/uncertain outcome/i)
  })
})
