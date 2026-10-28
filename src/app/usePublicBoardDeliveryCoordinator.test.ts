import { effectScope, nextTick, ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { usePublicBoardDeliveryCoordinator } from "./usePublicBoardDeliveryCoordinator"

const mocks = vi.hoisted(() => ({
  role: vi.fn(), ownerHook: vi.fn(), editorHook: vi.fn(),
}))
vi.mock("@automerge/automerge/slim", () => ({ getHeads: () => ["a".repeat(64)] }))
vi.mock("../sync/changeAuthorization", () => ({ workspaceRole: mocks.role }))
vi.mock("./usePublicBoardAccess", () => ({ usePublicBoardAccess: mocks.ownerHook }))
vi.mock("./usePublicBoardDelivery", () => ({ usePublicBoardDelivery: mocks.editorHook }))

describe("public delivery workspace coordinator", () => {
  let scope = effectScope()
  let ids = ref(["workspace-a", "workspace-b"])
  let localListener: ((workspaceId?: string) => void) | undefined
  let chatListener: ((event: { workspaceId: string; contentChanged?: boolean }) => void) | undefined
  let readWorkspaceDoc: ReturnType<typeof vi.fn>
  let profile = ref({ identity: { personId: "owner" }, device: { deviceId: "device" } })

  beforeEach(() => {
    vi.useFakeTimers()
    scope = effectScope()
    ids = ref(["workspace-a", "workspace-b"])
    profile = ref({ identity: { personId: "owner" }, device: { deviceId: "device" } })
    localListener = undefined
    chatListener = undefined
    mocks.role.mockReset().mockResolvedValue("owner")
    mocks.ownerHook.mockReset().mockReturnValue({ busy: ref(false), published: ref(true), error: ref("") })
    mocks.editorHook.mockReset().mockReturnValue({ busy: ref(false), status: ref("waiting"), error: ref("") })
    readWorkspaceDoc = vi.fn(async (workspaceId: string) => ({ id: workspaceId, ownerPersonId: "owner", entities: {
      [`${workspaceId}-board`]: { id: `${workspaceId}-board`, kind: "board", title: "Board" },
    } }))
  })
  afterEach(() => { scope.stop(); vi.useRealTimers() })

  it("loads eligible workspaces once at startup and reloads only the workspace named by a notification", async () => {
    scope.run(() => usePublicBoardDeliveryCoordinator({ origin: () => "https://rusty.test", ready: () => true,
      workspaceIds: () => ids.value, profile: () => profile.value as never, readWorkspaceDoc: readWorkspaceDoc as never,
      debounceMs: 10,
      subscribeLocalChanges: listener => { localListener = listener; return () => {} },
      subscribeChat: listener => { chatListener = listener as typeof chatListener; return () => {} },
    }))
    await nextTick()
    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => expect(readWorkspaceDoc).toHaveBeenCalledTimes(2))
    expect(mocks.ownerHook).toHaveBeenCalledTimes(2)

    localListener?.("workspace-b")
    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => expect(readWorkspaceDoc).toHaveBeenCalledTimes(3))
    expect(readWorkspaceDoc.mock.calls.map(([id]) => id).sort()).toEqual(["workspace-a", "workspace-b", "workspace-b"])

    chatListener?.({ workspaceId: "workspace-a" })
    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => expect(readWorkspaceDoc).toHaveBeenCalledTimes(4))
    expect(readWorkspaceDoc.mock.calls[3]?.[0]).toBe("workspace-a")
  })

  it("selects editor delivery only after workspace role verification", async () => {
    mocks.role.mockResolvedValue("editor")
    scope.run(() => usePublicBoardDeliveryCoordinator({ origin: () => "https://rusty.test", ready: () => true,
      workspaceIds: () => ["workspace-a"], profile: () => profile.value as never, readWorkspaceDoc: readWorkspaceDoc as never,
      debounceMs: 1, subscribeLocalChanges: () => () => {}, subscribeChat: () => () => {},
    }))
    await nextTick()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(mocks.editorHook).toHaveBeenCalledTimes(1))
    expect(mocks.ownerHook).not.toHaveBeenCalled()
  })

  it("Given a verified owner board, when chat reports only transient typing, then keep its role and delivery scope until durable content changes", async () => {
    scope.run(() => usePublicBoardDeliveryCoordinator({ origin: () => "https://rusty.test", ready: () => true,
      workspaceIds: () => ["workspace-a"], profile: () => profile.value as never, readWorkspaceDoc: readWorkspaceDoc as never,
      debounceMs: 10, subscribeLocalChanges: () => () => {},
      subscribeChat: listener => { chatListener = listener as typeof chatListener; return () => {} },
    }))
    await nextTick()
    await vi.advanceTimersByTimeAsync(10)
    await vi.waitFor(() => expect(mocks.ownerHook).toHaveBeenCalledOnce())
    const access = mocks.ownerHook.mock.calls[0]![0]
    const version = access.sourceVersion()
    chatListener?.({ workspaceId: "workspace-a", contentChanged: false })
    expect(access.owner()).toBe(true)
    await vi.advanceTimersByTimeAsync(10)
    expect(readWorkspaceDoc).toHaveBeenCalledOnce()
    expect(access.sourceVersion()).toBe(version)
    chatListener?.({ workspaceId: "workspace-a", contentChanged: true })
    expect(access.owner()).toBe(false)
    await vi.advanceTimersByTimeAsync(10)
    expect(readWorkspaceDoc).toHaveBeenCalledTimes(2)
    expect(access.owner()).toBe(true)
    expect(access.sourceVersion()).toBeGreaterThan(version)
  })

  it("does not duplicate the active board and reconsiders it when it leaves the UI", async () => {
    const active = ref<{ workspaceId: string; boardId: string } | null>({
      workspaceId: "workspace-a", boardId: "workspace-a-board",
    })
    scope.run(() => usePublicBoardDeliveryCoordinator({ origin: () => "https://rusty.test", ready: () => true,
      workspaceIds: () => ["workspace-a"], profile: () => profile.value as never, readWorkspaceDoc: readWorkspaceDoc as never,
      activeBoard: () => active.value, debounceMs: 1,
      subscribeLocalChanges: () => () => {}, subscribeChat: () => () => {},
    }))
    await nextTick()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(readWorkspaceDoc).toHaveBeenCalledTimes(1))
    expect(mocks.ownerHook).not.toHaveBeenCalled()

    active.value = null
    await nextTick()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(mocks.ownerHook).toHaveBeenCalledTimes(1))
  })

  it("restarts workspace admission checks when local profile identity changes", async () => {
    scope.run(() => usePublicBoardDeliveryCoordinator({ origin: () => "https://rusty.test", ready: () => true,
      workspaceIds: () => ["workspace-a"], profile: () => profile.value as never, readWorkspaceDoc: readWorkspaceDoc as never,
      debounceMs: 1, subscribeLocalChanges: () => () => {}, subscribeChat: () => () => {},
    }))
    await nextTick()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(readWorkspaceDoc).toHaveBeenCalledTimes(1))

    profile.value = { identity: { personId: "next-owner" }, device: { deviceId: "next-device" } }
    await nextTick()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => expect(readWorkspaceDoc).toHaveBeenCalledTimes(2))
    expect(mocks.role).toHaveBeenCalledTimes(2)
  })
})
