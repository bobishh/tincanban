import { describe, expect, it, vi } from "vitest"
import { userMessage, useDeviceSync } from "./useDeviceSync"
import { formatSyncError } from "./deviceSyncState"
import { DeviceSyncController } from "./deviceSyncController"
import { WorkspaceAdmissionFailure } from "./deviceSyncHost"
import { ref } from "vue"
import type { SyncTransport } from "./transport"

const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error("Condition was not met")
}

describe("device sync errors", () => {
  it("explains a archived local copy without blaming another open tab", () => {
    const cause = "Workspace issues: Workspace was archived in another tab"
    expect(userMessage(new Error(cause), "Try again.")).toBe(
      `This board was archived on this device. Rejoining cannot restore that local copy yet. Use a new board or a fresh browser profile. Details: ${cause}`,
    )
  })

  it("preserves the bounded root cause for live-session diagnostics", () => {
    const error = new Error("Workspace board (Job search) snapshot failed: Workspace storage is unavailable")
    expect(formatSyncError(error, "Live sync stopped.")).toBe(error.message)
    expect(formatSyncError(new Error("x".repeat(600)), "Live sync stopped.")).toHaveLength(512)
  })

  it("Given a CRDT merge failure, when pairing reports it, then the UI does not blame the QR code", () => {
    expect(userMessage(new RangeError("Attempting to change an outdated document"), "Generate a new QR and try again.")).toBe(
      "Couldn’t merge workspace changes. Keep this tab open and try pairing again.",
    )
  })

  it("Given a malformed pairing link, when parsing fails, then the UI identifies the link", () => {
    expect(userMessage(new Error("Invalid pairing link"), "Generate a new QR and try again.")).toBe("This pairing link is invalid.")
  })

  it("Given both routes fail, when pairing reports an aggregate error, then the UI identifies a connection problem", () => {
    const error = new AggregateError([
      new Error("No addressing information available for remote endpoint"),
      new Error("relay connection timed out"),
    ])

    expect(userMessage(error, "Try again.")).toBe("Couldn’t reach the other device. Check both connections and try again.")
  })
})

describe("useDeviceSync direct sync selection and custom workspace sets", () => {
  it.each([false, true])("Given the direct node closes (cleanup fails: %s), then durable mesh adopts it and keeps reconnecting", async cleanupFails => {
    let rejectSession!: (error: unknown) => void
    const session = {
      done: new Promise<void>((_, reject) => { rejectSession = reject }),
      publish: vi.fn(async () => undefined),
      close: vi.fn(async () => { if (cleanupFails) throw new Error("connection already closed") }),
    }
    const node = { close: vi.fn(async () => undefined) }
    const durableMesh = {
      revokedWorkspaceIds: vi.fn(async () => []),
      resumeAll: vi.fn(async () => undefined),
    }
    const controller = new DeviceSyncController({ workspace: {}, origin: () => "http://localhost:3000" })
    const sync = controller.api()
    const internal = controller as unknown as {
      node: typeof node
      durableMesh: typeof durableMesh
      attachLiveSession: (liveSession: typeof session, currentRun: number) => void
    }
    internal.node = node
    internal.durableMesh = durableMesh
    internal.attachLiveSession(session, 0)

    rejectSession(new Error("browser runtime node is closed"))
    await waitFor(() => durableMesh.resumeAll.mock.calls.length === 1)

    expect(session.close).toHaveBeenCalledOnce()
    expect(durableMesh.resumeAll).toHaveBeenCalledWith(node)
    expect(node.close).not.toHaveBeenCalled()
    expect(sync.step.value).toBe("workspace-reconnecting")
    expect(sync.error.value).toBe("")
  })

  it("Given one direct peer sends an invalid protocol record, when that session fails, then durable mesh keeps the runtime available", async () => {
    let rejectSession!: (error: unknown) => void
    const session = {
      done: new Promise<void>((_, reject) => { rejectSession = reject }),
      publish: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }
    const node = { close: vi.fn(async () => undefined) }
    const durableMesh = {
      revokedWorkspaceIds: vi.fn(async () => []),
      resumeAll: vi.fn(async () => undefined),
    }
    const controller = new DeviceSyncController({ workspace: {}, origin: () => "http://localhost:3000" })
    const sync = controller.api()
    const internal = controller as unknown as {
      node: typeof node
      durableMesh: typeof durableMesh
      attachLiveSession: (liveSession: typeof session, currentRun: number) => void
    }
    internal.node = node
    internal.durableMesh = durableMesh
    internal.attachLiveSession(session, 0)

    rejectSession(new Error("Invalid workspace grant signature"))
    await waitFor(() => session.close.mock.calls.length === 1)

    expect(durableMesh.resumeAll).toHaveBeenCalledWith(node)
    expect(sync.step.value).toBe("workspace-reconnecting")
    expect(sync.error.value).toBe("")
  })

  it("Given workspace admission fails before a peer connects, when recovery adopts durable mesh, then host keeps terminal cause visible", async () => {
    let rejectSession!: (error: unknown) => void
    const session = {
      done: new Promise<void>((_, reject) => { rejectSession = reject }),
      publish: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }
    const node = { close: vi.fn(async () => undefined) }
    const durableMesh = {
      revokedWorkspaceIds: vi.fn(async () => []),
      resumeAll: vi.fn(async () => undefined),
    }
    const controller = new DeviceSyncController({ workspace: {}, origin: () => "http://localhost:3000" })
    const sync = controller.api()
    const internal = controller as unknown as {
      node: typeof node
      durableMesh: typeof durableMesh
      attachLiveSession: (liveSession: typeof session, currentRun: number) => void
    }
    internal.node = node
    internal.durableMesh = durableMesh
    sync.step.value = "workspace-host"
    internal.attachLiveSession(session, 0)

    rejectSession(new WorkspaceAdmissionFailure(new Error("Snapshot preparation failed")))
    await waitFor(() => durableMesh.resumeAll.mock.calls.length === 1)

    expect(session.close).toHaveBeenCalledOnce()
    expect(durableMesh.resumeAll).toHaveBeenCalledWith(node)
    expect(sync.step.value).toBe("error")
    expect(sync.error.value).toBe("Snapshot preparation failed")
  })

  it("keeps sync enabled while no peer session is connected, and only disables it when stopped", async () => {
    const sync = useDeviceSync({ workspace: {}, origin: () => "http://localhost:3000" } as never)

    await sync.startDurableMesh()

    expect(sync.isLive.value).toBe(false)
    expect(sync.isEnabled.value).toBe(true)

    await sync.stopLiveSync()

    expect(sync.isEnabled.value).toBe(false)
  })

  it.each(["enroll-host", "enroll-host-preparing"] as const)("restores the active %s screen after hiding the dialog", async step => {
    const sync = useDeviceSync({ workspace: {}, origin: () => "http://localhost:3000" } as never)
    sync.step.value = step
    sync.isOpen.value = true
    await sync.dismiss()
    sync.open()
    expect(sync.isOpen.value).toBe(true)
    expect(sync.step.value).toBe(step)
  })

  it("Given Device Sync opens, then mesh members appear before the add flow without starting transport", () => {
    let transportStarted = false
    const mockTransport = {
      start: async () => {
        transportStarted = true
        throw new Error("Should not start node on open")
      },
    } satisfies SyncTransport
    const availableWorkspaces = [
      { id: "ws_1", title: "Job search" },
      { id: "ws_2", title: "Reading list" },
    ]
    const sync = useDeviceSync({
      workspace: {},
      origin: () => "http://localhost:3000",
      transport: mockTransport,
      availableWorkspaces: ref(availableWorkspaces),
      activeWorkspaceId: () => "ws_1",
    })

    sync.open()
    expect(sync.isOpen.value).toBe(true)
    expect(sync.step.value).toBe("members")
    expect(sync.selectedWorkspaceIds.value).toEqual(["ws_1"])
    expect(transportStarted).toBe(false)
  })

  it("handles empty workspace selection disabling generation", async () => {
    const sync = useDeviceSync({
      workspace: {},
      origin: () => "http://localhost:3000",
      availableWorkspaces: ref([{ id: "ws_1", title: "Job search" }]),
      activeWorkspaceId: () => "ws_1",
    })

    sync.open()
    sync.selectSyncWorkspace()
    sync.selectedWorkspaceIds.value = []
    await sync.generateWorkspaceInvite()
    // Generation must fail or be disabled when selection is empty
    expect(sync.step.value).toBe("workspace-select")
    expect(sync.inviteUrl.value).toBe("")
  })

  it("Given an editor, when they generate an invite, rejects before starting a network node", async () => {
    let transportStarted = false
    const sync = useDeviceSync({
      workspace: {},
      origin: () => "http://localhost:3000",
      transport: { start: async () => { transportStarted = true; throw new Error("must not start") } } satisfies SyncTransport,
      availableWorkspaces: ref([{ id: "ws_1", title: "Shared" }]),
      activeWorkspaceId: () => "ws_1",
      workspaceOwner: async () => "another-person",
    })

    sync.open()
    await sync.generateWorkspaceInvite()

    expect(transportStarted).toBe(false)
    expect(sync.step.value).toBe("error")
    expect(sync.error.value).toBe("Only the workspace owner can invite peers to Shared")
  })

  it("handles expired invitation by setting error state and preventing connection", async () => {
    const start = vi.fn(async () => { throw new Error("Expired invitation must not start transport") })
    const sync = useDeviceSync({
      workspace: {},
      transport: { start } as never,
      origin: () => "http://localhost:3000",
    })

    const expiredUrl = "http://localhost:3000/pair#v=1&kind=workspace-join&invitationId=exp1&issuerPersonId=p1&issuerDeviceId=d1&issuerPublicKey=pk1&endpoint=ep1&createdAt=2020-01-01T00:00:00.000Z&expiresAt=2020-01-01T00:10:00.000Z&secret=sec1&workspaceId=ws1&workspaceTitle=WS&role=editor"
    await sync.prepareJoin(expiredUrl)

    expect(sync.step.value).toBe("error")
    expect(sync.error.value).toMatch(/This invitation has expired/i)
    expect(start).not.toHaveBeenCalled()
    expect(sync.inviteUrl.value).toBe("")
  })
})
