import { afterEach, expect, it, vi } from "vitest"
import { WorkspaceStorage } from "./storage"
import { clearLocalJournal } from "./storageJournal"

afterEach(() => vi.unstubAllGlobals())

it("Given local history progress without IndexedDB, when a history transition is claimed and retried, then preserve its durable identity until completion", async () => {
  vi.stubGlobal("indexedDB", undefined)
  const workspaceId = crypto.randomUUID(), storage = new WorkspaceStorage()
  try {
    await storage.ensureHistoryProgress(workspaceId)
    const first = await storage.claimHistoryTransitionId(workspaceId)
    const revision = await storage.readWorkspaceRevision(workspaceId)
    expect(first.previousBaselineId).toBeNull()
    expect(first.transitionId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(await storage.claimHistoryTransitionId(workspaceId)).toEqual(first)
    expect(await storage.readWorkspaceRevision(workspaceId)).toBe(revision)

    await storage.completeHistoryTransition(workspaceId, first.transitionId)
    expect((await storage.claimHistoryTransitionId(workspaceId)).transitionId).not.toBe(first.transitionId)
  } finally { clearLocalJournal(workspaceId) }
})
