import { effectScope, nextTick, ref, shallowRef } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePublicBoardAccess } from "./usePublicBoardAccess"
import { createWorkspaceDoc } from "../test/boardFixture"
import { canonicalizeJson, sha256Base64Url } from "../domain/identity"
import { createBrowserBoardPublication } from "./publicBoardPublication"
import type * as PublicationClient from "../public/publicationClient"

const mocks = vi.hoisted(() => ({
  read: vi.fn(), compare: vi.fn(), publish: vi.fn(), withdraw: vi.fn(),
  buildPolicy: vi.fn(), policyHash: vi.fn(), policyContentHash: vi.fn(),
  chatRevision: vi.fn(),
  chat: vi.fn(), attachment: vi.fn(),
}))
vi.mock("../chat/service", () => ({ readChatContentRevision: mocks.chatRevision, getChatScope: async () => "chat-scope", loadChat: mocks.chat }))
vi.mock("../attachments", () => ({ readAttachment: mocks.attachment }))
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
  let scope = effectScope()
  let boardId = ref("board-a")
  let workspaceId = ref("workspace-a")
  let sourceVersion = ref(1)
  let isOwner = ref(true)
  let document = shallowRef({ entities: {} })
  let profile = ref({ identity: { personId: "person-a" }, device: { deviceId: "device-a" } })

  beforeEach(() => {
    vi.useFakeTimers()
    scope = effectScope()
    boardId = ref("board-a")
    workspaceId = ref("workspace-a")
    sourceVersion = ref(1)
    isOwner = ref(true)
    document = shallowRef({ entities: {} })
    profile = ref({ identity: { personId: "person-a" }, device: { deviceId: "device-a" } })
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
      sourceHeads: () => ["head-a"],
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
    sourceVersion.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.compare).toHaveBeenCalledTimes(1))
    expect(mocks.publish).not.toHaveBeenCalled()
    mocks.compare.mockResolvedValueOnce(true)
    sourceVersion.value++
    await nextTick()
    await vi.advanceTimersByTimeAsync(20)
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))
    expect(mocks.publish.mock.calls[0]?.[0]).toMatchObject({ action: "update", expectedRevision: 4 })
    expect(mocks.publish.mock.calls[0]?.[0].deliveryPolicy).toBeUndefined()
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
    const { projection } = await createBrowserBoardPublication(doc, doc.id, board.id)
    const hash = await sha256Base64Url(new TextEncoder().encode(canonicalizeJson(projection)))
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
    sourceVersion.value++
    await nextTick()
    finishPublish({ revision: 1, hash: "stale", url: "https://app.test/boards/board-a" })
    await expect(operation).rejects.toThrow(/changed/)
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

  it("refreshes the signed management revision before retrying a failed publication", async () => {
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
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(2))
    expect(mocks.publish.mock.calls[1]?.[0].expectedRevision).toBe(7)
  })
})
