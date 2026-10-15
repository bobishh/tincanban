import { describe, expect, it, vi } from "vitest"
import { DeviceSyncController } from "./deviceSyncController"
import type { DeviceSyncOptions } from "./deviceSyncController"
import type { LiveWorkspaceSync } from "./workspaceSet"
import type { DurableMesh } from "./durableMesh"
import { PeerHistoryObjectUnavailableError } from "./peerHistoryTransport"

describe("device history-object reads", () => {
  it("routes exact older-baseline discovery through the authorized peer session", async () => {
    const descriptor = { version: 1 as const, sourceKind: "authenticated-peer-plaintext" as const, signedJson: "e30",
      baselineId: "b".repeat(43), documentDigest: "c".repeat(43), documentLength: 42 }
    const readHistoryBaseline = vi.fn(async () => descriptor)
    const readHistoryDocument = vi.fn(async () => new Uint8Array([4, 2]))
    const controller = new DeviceSyncController({ workspace: {}, origin: () => "https://local.test" } as unknown as DeviceSyncOptions)
    ;(controller as unknown as { replaceDirectSession(personId: string, session: LiveWorkspaceSync): unknown })
      .replaceDirectSession("peer", { readHistoryBaseline, readHistoryDocument } as unknown as LiveWorkspaceSync)

    await expect(controller.api().fetchHistoryBaseline("board-a", descriptor.baselineId)).resolves.toEqual(descriptor)
    await expect(controller.api().fetchHistoryDocument("board-a", descriptor)).resolves.toEqual(new Uint8Array([4, 2]))
    expect(readHistoryBaseline).toHaveBeenCalledWith("board-a", descriptor.baselineId)
    expect(readHistoryDocument).toHaveBeenCalledWith(descriptor, "board-a")
  })

  it("Given an authenticated live peer, When a backup requests one bound object, Then it forwards the exact baseline and binding", async () => {
    const readHistoryObject = vi.fn(async () => new Uint8Array([4, 5, 6]))
    const controller = new DeviceSyncController({ workspace: {}, origin: () => "https://local.test" } as unknown as DeviceSyncOptions)
    ;(controller as unknown as { replaceDirectSession(personId: string, session: LiveWorkspaceSync): unknown })
      .replaceDirectSession("peer", { readHistoryObject } as unknown as LiveWorkspaceSync)
    const binding = { workspaceId: "board-a", historyEpoch: 5, indexId: "catalogue", objectKind: "record" as const,
      partIndex: 0, partCount: 1 }

    await expect(controller.api().fetchHistoryObject("board-a", "a".repeat(43), "b".repeat(43), binding))
      .resolves.toEqual(new Uint8Array([4, 5, 6]))
    expect(readHistoryObject).toHaveBeenCalledWith("a".repeat(43), "b".repeat(43), binding)
  })

  it("Given an authenticated guest session before durable handoff, when reading earlier history, then use its exact active channel", async () => {
    const readHistoryObject = vi.fn(async () => new Uint8Array([6]))
    const controller = new DeviceSyncController({ workspace: {}, origin: () => "https://local.test" } as unknown as DeviceSyncOptions)
    ;(controller as unknown as { liveSession: LiveWorkspaceSync }).liveSession = { readHistoryObject } as unknown as LiveWorkspaceSync
    const binding = { workspaceId: "board-a", historyEpoch: 1, indexId: "catalogue", objectKind: "page" as const,
      partIndex: 0, partCount: 1 }
    await expect(controller.api().fetchHistoryObject("board-a", "a".repeat(43), "b".repeat(43), binding))
      .resolves.toEqual(new Uint8Array([6]))
    expect(readHistoryObject).toHaveBeenCalledWith("a".repeat(43), "b".repeat(43), binding)
  })

  it("Given its last durable peer disconnected, when exporting private history, then report missing coverage rather than aborting the backup", async () => {
    const controller = new DeviceSyncController({ workspace: {}, origin: () => "https://local.test" } as unknown as DeviceSyncOptions)
    ;(controller as unknown as { durableMesh: DurableMesh }).durableMesh = {
      fetchHistoryObject: async () => { throw new PeerHistoryObjectUnavailableError("History peer session was replaced") },
    } as unknown as DurableMesh
    await expect(controller.api().fetchHistoryObject("board-a", "a".repeat(43), "b".repeat(43), {
      workspaceId: "board-a", historyEpoch: 1, indexId: "catalogue", objectKind: "page", partIndex: 0, partCount: 1,
    })).resolves.toBeUndefined()
  })

  it("rejects a request whose object binding names another workspace", async () => {
    const controller = new DeviceSyncController({ workspace: {}, origin: () => "https://local.test" } as unknown as DeviceSyncOptions)
    await expect(controller.api().fetchHistoryObject("board-a", "a".repeat(43), "b".repeat(43), {
      workspaceId: "board-b", historyEpoch: 1, indexId: "catalogue", objectKind: "record", partIndex: 0, partCount: 1,
    })).rejects.toThrow(/workspace baseline/i)
  })

  it("tries another authorized direct peer when one does not retain the requested object", async () => {
    const controller = new DeviceSyncController({ workspace: {}, origin: () => "https://local.test" } as unknown as DeviceSyncOptions)
    const attach = (personId: string, readHistoryObject: LiveWorkspaceSync["readHistoryObject"]) =>
      (controller as unknown as { replaceDirectSession(personId: string, session: LiveWorkspaceSync): unknown })
        .replaceDirectSession(personId, { readHistoryObject } as unknown as LiveWorkspaceSync)
    attach("peer-a", vi.fn(async () => { throw new PeerHistoryObjectUnavailableError() }))
    const second = vi.fn(async () => new Uint8Array([9]))
    attach("peer-b", second)

    await expect(controller.api().fetchHistoryObject("board-a", "a".repeat(43), "b".repeat(43), {
      workspaceId: "board-a", historyEpoch: 1, indexId: "catalogue", objectKind: "record", partIndex: 0, partCount: 1,
    })).resolves.toEqual(new Uint8Array([9]))
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("returns no object when all live peers report the baseline item missing", async () => {
    const controller = new DeviceSyncController({ workspace: {}, origin: () => "https://local.test" } as unknown as DeviceSyncOptions)
    ;(controller as unknown as { replaceDirectSession(personId: string, session: LiveWorkspaceSync): unknown })
      .replaceDirectSession("peer", { readHistoryObject: async () => { throw new PeerHistoryObjectUnavailableError() } } as unknown as LiveWorkspaceSync)

    await expect(controller.api().fetchHistoryObject("board-a", "a".repeat(43), "b".repeat(43), {
      workspaceId: "board-a", historyEpoch: 1, indexId: "catalogue", objectKind: "record", partIndex: 0, partCount: 1,
    })).resolves.toBeUndefined()
  })
})
