import { expect, it, vi } from "vitest"
import { MeshNetworkError } from "@meta-uber/mesh-transport"
import type { DurableMesh } from "./durableMesh"
import type { LiveWorkspaceSync } from "./workspaceSet"
import { createPeerHistoryReadActions } from "./peerHistoryRequestRouting"

const baselineId = "B".repeat(43), objectId = "O".repeat(43)
const descriptor = { version: 1, sourceKind: "authenticated-peer-plaintext", baselineId,
  signedJson: "signed", documentDigest: "D".repeat(43), documentLength: 1 } as const
const binding = { workspaceId: "board", historyEpoch: 1, indexId: "catalogue",
  objectKind: "record", partIndex: 0, partCount: 1 } as const

it.each(["object", "baseline", "document"] as const)(
  "Given a direct peer replacement during a durable %s read, when that read loses its session, then use the current direct peer", async kind => {
    const stale = { readHistoryObject: vi.fn(), readHistoryBaseline: vi.fn(), readHistoryDocument: vi.fn() }
    const current = { readHistoryObject: vi.fn(async () => new Uint8Array([7])),
      readHistoryBaseline: vi.fn(async () => descriptor), readHistoryDocument: vi.fn(async () => new Uint8Array([7])) }
    let sessions = [stale] as unknown as LiveWorkspaceSync[]
    const loseSession = async () => { sessions = [current] as unknown as LiveWorkspaceSync[]; throw new MeshNetworkError("Session replaced") }
    const mesh = { fetchHistoryObject: loseSession, fetchHistoryBaseline: loseSession, fetchHistoryDocument: loseSession } as unknown as DurableMesh
    const actions = createPeerHistoryReadActions({ durableMesh: () => mesh, durableMeshPromise: () => undefined,
      directPeerSessions: () => new Set(sessions) })
    const result = kind === "object" ? actions.fetchHistoryObject("board", baselineId, objectId, binding)
      : kind === "baseline" ? actions.fetchHistoryBaseline("board", baselineId)
        : actions.fetchHistoryDocument("board", descriptor)
    await expect(result).resolves.toEqual(kind === "baseline" ? descriptor : new Uint8Array([7]))
    for (const read of Object.values(stale)) expect(read).not.toHaveBeenCalled()
  })

it("Given a durable history authorization or protocol failure, when fallback is available, then propagate the failure without reading another peer", async () => {
  const read = vi.fn()
  const mesh = { fetchHistoryObject: async () => { throw new Error("Authority changed") } } as unknown as DurableMesh
  const actions = createPeerHistoryReadActions({ durableMesh: () => mesh, durableMeshPromise: () => undefined,
    directPeerSessions: () => [{ readHistoryObject: read }] as unknown as LiveWorkspaceSync[] })
  await expect(actions.fetchHistoryObject("board", baselineId, objectId, binding)).rejects.toThrow("Authority changed")
  expect(read).not.toHaveBeenCalled()
})
