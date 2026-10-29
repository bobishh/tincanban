import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createHistoryCompactionAction } from "./privateHistoryCompactionAction"
import { createReplicationState } from "./privateReplicationState"
import type { BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import type { BlindReplicaConfig } from "./blindReplication"
import type { HistoryBaselineTransitionPorts } from "./historyBaselineTransition"
import * as replicaRepository from "./privateReplicaRepository"
import { emptyReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { defaultStorage } from "../storage"
const coordinate = vi.hoisted(() => vi.fn<(input: { config: BlindReplicaConfig; ports?: HistoryBaselineTransitionPorts }) => Promise<void>>().mockResolvedValue(undefined))
vi.mock("./historyBaselineTransition", () => ({ coordinateWorkspaceHistoryBaseline: coordinate }))
const checkpoint = vi.hoisted(() => ({ fence: vi.fn() }))
vi.mock("./blindHistoryCheckpoint", () => ({ assertHistoryStorageCheckpointSupport: vi.fn(async () => {}),
  recordHistoryStorageFence: checkpoint.fence, historyCheckpointDeliveryPrepared: vi.fn(async () => false), HistoryStorageCheckpointConflictError: class extends Error {} }))
beforeEach(() => { coordinate.mockReset().mockResolvedValue(undefined); checkpoint.fence.mockReset() })
afterEach(() => vi.restoreAllMocks())

it("Given committed Rusty settings, when archiving, then use a plain snapshot without starting another global sync", async () => {
  const config: BlindReplicaConfig = { purpose: "workspace", origin: "https://rusty.example", scopeId: "scope-for-history", workspaceId: "board", keyEpoch: 1,
    servicePublicKey: "A".repeat(43), contentKey: "A".repeat(43), readToken: "R".repeat(43), writeToken: "W".repeat(43),
    cursor: 0, lastUploaded: "", policyRevision: 1 }
  const state = createReplicationState()
  state.configs.value = [config]
  state.historyNotices.value.board = "Older history archived. Previous versions remain available."
  state.historyNotices.value.other = "Other workspace completion"
  const guard = vi.fn()
  const ensureProgress = vi.spyOn(defaultStorage, "ensureHistoryProgress").mockResolvedValue({ id: "board", workspaceId: "board",
    baselineId: null, admittedChanges: 1, encodedBytes: 1 })
  vi.spyOn(defaultStorage, "claimHistoryTransitionId").mockImplementation(async () => {
    expect(ensureProgress).toHaveBeenCalledWith("board")
    return { transitionId: "transition", previousBaselineId: null }
  })
  const switchWorkspace = vi.fn(async () => undefined)
  vi.spyOn(defaultStorage, "completeHistoryTransition").mockImplementation(async () => {
    expect(switchWorkspace).toHaveBeenCalledWith("board")
    expect(state.historyNotices.value.board).toBeUndefined()
  })
  const lifecycle = { identity: () => "owner", epoch: () => 1, disposed: () => false, reload: vi.fn(async () => undefined),
    syncNow: vi.fn(async () => undefined) }
  const compact = createHistoryCompactionAction({ getActiveDoc: () => ({ id: "board" }), switchWorkspace } as unknown as Parameters<typeof createHistoryCompactionAction>[0], state,
    { captureSession: () => guard } as unknown as Parameters<typeof createHistoryCompactionAction>[2],
    lifecycle as Parameters<typeof createHistoryCompactionAction>[3], new Set())
  await compact("board")
  expect(coordinate).toHaveBeenCalledWith(expect.objectContaining({ config }))
  expect(lifecycle.syncNow).not.toHaveBeenCalled()
  expect(() => structuredClone(coordinate.mock.calls[0]![0].config)).not.toThrow()
  expect(state.busy.value).toBe(false)
  expect(state.historyNotices.value.board).toBe("Older history archived. Previous versions remain available.")
})

it.each([true, false])("Given own upload advances Rusty after a pull, when caught-up=%s, then confirm a final pull before recording the admitted cursor fence", async caughtUp => {
  const config = { purpose: "workspace", origin: "https://rusty.example", scopeId: "scope-history", workspaceId: "board",
    keyEpoch: 1, servicePublicKey: "A".repeat(43), contentKey: "A".repeat(43), readToken: "read", writeToken: "write",
    policyRevision: 1, cursor: 5, lastUploaded: "old" } satisfies BlindReplicaConfig
  const state = createReplicationState(); state.configs.value = [config]
  const order: string[] = [], progress = emptyReplicaState<BlindObject>("binding", 5)
  const replica = { sync: vi.fn(async () => { order.push("sync") }),
    flushCurrentSnapshot: vi.fn(async () => { order.push("flush-own-upload") }),
    pull: vi.fn(async () => { order.push("pull-and-admit"); if (caughtUp) progress.cursor = 6; return caughtUp }) }
  vi.spyOn(replicaRepository, "getPrivateReplicaProgress").mockImplementation(async () => { order.push("read-admitted-cursor"); return progress })
  checkpoint.fence.mockImplementation(async (...args: unknown[]) => { order.push("record-fence"); expect(args[3]).toBe(6) })
  vi.spyOn(defaultStorage, "ensureHistoryProgress").mockResolvedValue({ id: "board", workspaceId: "board",
    baselineId: null, admittedChanges: 1, encodedBytes: 1 })
  vi.spyOn(defaultStorage, "claimHistoryTransitionId").mockResolvedValue({ transitionId: crypto.randomUUID(), previousBaselineId: null })
  vi.spyOn(defaultStorage, "completeHistoryTransition").mockResolvedValue(undefined)
  coordinate.mockImplementation(async input => { await input.ports!.drainOwner([]); order.push("capture") })
  const guard = vi.fn(), lifecycle = { identity: () => "owner", epoch: () => 1, disposed: () => false, reload: vi.fn(), syncNow: vi.fn(async () => {}) }
  const compact = createHistoryCompactionAction({ getActiveDoc: () => ({ id: "board" }), switchWorkspace: vi.fn(async () => {}) } as never,
    state, { captureSession: () => guard, replica: async () => replica } as never, lifecycle, new Set())
  if (caughtUp) {
    await compact("board")
    expect(order).toEqual(["sync", "flush-own-upload", "pull-and-admit", "read-admitted-cursor", "record-fence", "capture"])
  } else {
    await expect(compact("board")).rejects.toThrow(/caught up|caught-up|catch up/i)
    expect(order).toEqual(["sync", "flush-own-upload", "pull-and-admit"])
    expect(checkpoint.fence).not.toHaveBeenCalled()
  }
})
