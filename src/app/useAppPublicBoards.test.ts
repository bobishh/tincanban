import { effectScope, nextTick, reactive, ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useAppPublicBoards } from "./useAppPublicBoards"

const mocks = vi.hoisted(() => ({ access: vi.fn(), editor: vi.fn(), background: vi.fn(), publish: vi.fn() }))
vi.mock("./usePublicBoardAccess", () => ({ usePublicBoardAccess: mocks.access }))
vi.mock("./usePublicBoardDelivery", () => ({ usePublicBoardDelivery: mocks.editor }))
vi.mock("./usePublicBoardDeliveryCoordinator", () => ({ usePublicBoardDeliveryCoordinator: mocks.background }))

describe("publication through connected board storage", () => {
  let scope = effectScope()
  let board = ref({ id: "board", title: "Job search", publicationOrigin: undefined as string | undefined })
  let connections = ref<Array<{ workspaceId: string; origin: string; removalPending?: boolean }>>([])
  let execute: ReturnType<typeof vi.fn>
  beforeEach(() => {
    scope = effectScope()
    board = ref({ id: "board", title: "Job search", publicationOrigin: undefined })
    connections = ref([])
    execute = vi.fn(async command => { board.value.publicationOrigin = command.origin })
    mocks.publish.mockReset().mockResolvedValue(undefined)
    mocks.access.mockReset().mockReturnValue({ owner: ref(true), privateConfirmed: ref(true), published: ref(false), checked: ref(true), busy: ref(false), setPublic: mocks.publish })
    mocks.editor.mockReset().mockReturnValue({})
    mocks.background.mockReset().mockReturnValue({})
  })
  afterEach(() => scope.stop())
  function create() {
    return scope.run(() => useAppPublicBoards({
      workspace: { activeBoard: board, activeWorkspace: reactive({ id: "workspace" }), getActiveDoc: () => null,
        docVersion: ref(1), availableWorkspaces: ref([]), getCurrentProfile: () => null, executeCommandAsync: execute },
      actions: { currentDocHeads: ref([]) },
      collaboration: { permissions: { confirmedRole: ref("owner") }, device: { blindReplication: { configs: connections }, sync: { isOpen: ref(false) } } },
    } as never, ref(true)))!
  }
  it("Given no connected Rusty, when a different board has storage, then keep this board unavailable without choosing that server", async () => {
    create()
    connections.value = [{ workspaceId: "other", origin: "https://other.example" }]
    await nextTick()
    expect(mocks.access.mock.calls[0]![0].origin()).toBe("")
    expect(mocks.publish).not.toHaveBeenCalled()
  })
  it("Given one connected Rusty, when the owner publishes, then persist this board's host before sending publication", async () => {
    const result = create()
    connections.value = [{ workspaceId: "workspace", origin: "https://rusty.example" }]
    await nextTick()
    expect(mocks.access.mock.calls[0]![0].origin()).toBe("https://rusty.example")
    await result.publicAccess.setPublic(true)
    expect(execute).toHaveBeenCalledWith({ kind: "setBoardPublicationOrigin", boardId: "board", origin: "https://rusty.example" })
    expect(board.value.publicationOrigin).toBe("https://rusty.example")
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(mocks.publish.mock.invocationCallOrder[0]!)
  })
  it("Given a retained publication host, when its connection is removed and another is added, then preserve the old host and stop automatic delivery", async () => {
    board.value.publicationOrigin = "https://original.example"
    create()
    connections.value = [{ workspaceId: "workspace", origin: "https://replacement.example" }]
    await nextTick()
    const access = mocks.access.mock.calls[0]![0]
    expect(access.origin()).toBe("https://original.example")
    expect(access.connected()).toBe(false)
    expect(mocks.editor.mock.calls[0]![0].origin()).toBe("")
  })
  it("Given multiple connected servers, when none is selected, then require an explicit choice", async () => {
    connections.value = [{ workspaceId: "workspace", origin: "https://one.example" }, { workspaceId: "workspace", origin: "https://two.example" }]
    const result = create()
    expect(mocks.access.mock.calls[0]![0].origin()).toBe("")
    await result.publicAccess.selectOrigin("https://two.example")
    expect(board.value.publicationOrigin).toBe("https://two.example")
    expect(mocks.access.mock.calls[0]![0].origin()).toBe("https://two.example")
  })
  it("Given a confirmed public copy, when another server is selected, then require withdrawal and leave the host unchanged", async () => {
    board.value.publicationOrigin = "https://original.example"
    connections.value = [{ workspaceId: "workspace", origin: "https://replacement.example" }]
    const result = create()
    mocks.access.mock.results[0]!.value.published.value = true
    await expect(result.publicAccess.selectOrigin("https://replacement.example")).rejects.toThrow(/Disable public access/)
    expect(execute).not.toHaveBeenCalled()
    expect(board.value.publicationOrigin).toBe("https://original.example")
  })
  it("Given an uncertain withdrawal, when local intent is private but Rusty still reports public access, then block switching hosts", async () => {
    board.value.publicationOrigin = "https://original.example"
    connections.value = [{ workspaceId: "workspace", origin: "https://replacement.example" }]
    const result = create()
    mocks.access.mock.results[0]!.value.privateConfirmed.value = false
    await expect(result.publicAccess.selectOrigin("https://replacement.example")).rejects.toThrow(/Disable public access/)
    expect(execute).not.toHaveBeenCalled()
  })
  it("Given the chosen server is disconnected, when publication is requested, then send neither a snapshot nor a host change", async () => {
    board.value.publicationOrigin = "https://original.example"
    const result = create()
    await expect(result.publicAccess.setPublic(true)).rejects.toThrow(/Connect Rusty/)
    expect(execute).not.toHaveBeenCalled()
    expect(mocks.publish).not.toHaveBeenCalled()
  })
})
