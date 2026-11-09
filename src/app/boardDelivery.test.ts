import { effectScope, reactive, nextTick } from "vue"
import { expect, it, vi } from "vitest"
import type { ChatChange } from "../chat/service"
import { DeviceSyncController } from "../sync/deviceSyncController"
import { deliverIndependent, startSharedBoardDelivery, type BoardDeliveryIntent } from "./boardDelivery"

const chat = vi.hoisted(() => ({ listeners: new Set<(event: ChatChange) => void>() }))
vi.mock("../chat/service", () => ({
  subscribeChat: (listener: (event: ChatChange) => void) => {
    chat.listeners.add(listener)
    return () => { chat.listeners.delete(listener) }
  },
}))

it("Given direct mesh is not installed, when a board changes or is selected, then Rusty still receives that board and mesh is not started", async () => {
  const controller = new DeviceSyncController({ workspace: {}, origin: () => "http://localhost" })
  const ensure = vi.spyOn(controller as unknown as { ensureDurableMesh: () => Promise<unknown> }, "ensureDurableMesh")
  const sync = controller.api()
  const rusty = vi.fn<(intent: BoardDeliveryIntent) => void>()
  const reported: unknown[] = []
  const listeners: Array<(workspaceId?: string) => void> = []
  const active = reactive({ id: "board-a" })
  const scope = effectScope()
  let stop = () => {}
  try {
    scope.run(() => {
      stop = startSharedBoardDelivery({
        subscribeLocalChanges: listener => { listeners.push(listener); return () => {} },
        activeWorkspaceId: () => active.id,
        deliver: intent => deliverIndependent([
          () => sync.deliverBoard(intent),
          () => { throw new Error("mesh consumer failed") },
          () => rusty(intent),
        ], cause => { reported.push(cause) }),
        deliverUnknown: () => deliverIndependent([
          () => sync.deliverUnknownBoard(),
          () => rusty({ workspaceId: "unknown", changed: true }),
        ], cause => { reported.push(cause) }),
      })
    })
    expect(typeof sync.deliverBoard).toBe("function")
    listeners[0]!("board-a")
    expect(rusty).toHaveBeenCalledWith({ workspaceId: "board-a", changed: true })
    expect(ensure).not.toHaveBeenCalled()
    expect(reported.some(cause => cause instanceof Error && cause.message === "mesh consumer failed")).toBe(true)
    active.id = "board-b"
    await nextTick()
    expect(rusty).toHaveBeenCalledWith({ workspaceId: "board-b", changed: false })
    for (const listener of chat.listeners) listener({ workspaceId: "board-a", added: [], remote: false, history: false, contentChanged: false })
    expect(rusty).not.toHaveBeenCalledWith({ workspaceId: "board-a", changed: false })
    const beforeTyping = rusty.mock.calls.length
    for (const listener of chat.listeners) listener({ workspaceId: "board-a", added: [], remote: false, history: false, contentChanged: false })
    expect(rusty).toHaveBeenCalledTimes(beforeTyping)
    for (const listener of chat.listeners) listener({ workspaceId: "board-c", added: [], remote: false, history: false })
    expect(rusty).toHaveBeenCalledWith({ workspaceId: "board-c", changed: true })
    listeners[0]!()
    expect(rusty).toHaveBeenCalledWith({ workspaceId: "unknown", changed: true })
  } finally { stop(); scope.stop() }
})
