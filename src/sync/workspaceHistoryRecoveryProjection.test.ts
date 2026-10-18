import { beforeEach, describe, expect, it, vi } from "vitest"

const ports = vi.hoisted(() => ({
  prepare: vi.fn(), activate: vi.fn(), current: vi.fn(), revision: vi.fn(),
  authority: vi.fn(), credential: vi.fn(), putAuthority: vi.fn(), putCredential: vi.fn(), transferCredential: vi.fn(),
  invalidate: vi.fn(), currentRoot: vi.fn(), catalog: vi.fn(),
  records: new Map<string, unknown>(),
}))
vi.mock("@meta-uber/mesh-browser-store", () => ({ BrowserMeshStore: class {
  async updateRecords(_store: string, keys: string[], change: (values: unknown[]) => { writes: Array<{key: string; value: unknown}>; result: unknown }) {
    const result = change(keys.map(key => ports.records.get(key)))
    for (const write of result.writes) ports.records.set(write.key, write.value)
    return result.result
  }
  async scan<T>(_store: string, prefix: string, after: string | undefined, limit: number) {
    const entries = [...ports.records.entries()].filter(([key]) => key.startsWith(prefix) && (!after || key > after))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => ({ key, value: value as T }))
    const more = [...ports.records.keys()].some(key => key.startsWith(prefix) && key > (entries.at(-1)?.key ?? after ?? ""))
    return { entries, nextAfter: more ? entries.at(-1)?.key ?? null : null }
  }
} }))
vi.mock("../localDb", () => ({ readLocal: ports.current, writeLocal: vi.fn(), deleteLocal: vi.fn() }))
vi.mock("../storageJournal", () => ({
  openWorkspaceJournal: async () => ({
    transaction: () => {
      const transaction: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void } = {}
      return {
        objectStore: () => ({
          get: () => {
            const request: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {}
            queueMicrotask(() => { request.result = { recoveryId: ports.revision() }; request.onsuccess?.(); transaction.oncomplete?.() })
            return request
          },
        }),
        set oncomplete(value: (() => void) | undefined) { transaction.oncomplete = value },
        get oncomplete() { return transaction.oncomplete },
        set onerror(value: (() => void) | undefined) { transaction.onerror = value },
        set onabort(value: (() => void) | undefined) { transaction.onabort = value },
      }
    },
  }),
}))
vi.mock("./identityDeviceTransfer", () => ({ readIdentityDeviceTransfer: ports.prepare }))
vi.mock("./identityDeviceActivation", () => ({ activateIdentityDeviceTransfer: ports.activate }))
vi.mock("./peerStore", () => ({ peerStore: {
  getWorkspaceAuthority: ports.authority, getWorkspaceCredential: ports.credential,
  putWorkspaceAuthority: ports.putAuthority, putWorkspaceCredential: ports.putCredential,
  transferWorkspaceCredential: ports.transferCredential,
} }))
vi.mock("../storage", () => ({ defaultStorage: { invalidateWorkspaceCache: ports.invalidate } }))
vi.mock("../statePersonalRoot", () => ({ registerWorkspaceInCurrentRoot: ports.currentRoot }))
vi.mock("../storageCatalog", () => ({ readWorkspaceCatalogRecords: ports.catalog }))

import { prepareWorkspaceHistoryRecoveryProjection, resumeWorkspaceHistoryRecoveryProjection } from "./workspaceHistoryRecoveryProjection"

const recoveryId = "b6d54b5f-a187-4f8f-88ce-47f25c791e38"

describe("workspace private recovery projection", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    ports.records.clear()
    ports.current.mockResolvedValue(JSON.stringify({ identity: { personId: "person" } }))
    ports.revision.mockReturnValue(recoveryId)
    ports.prepare.mockResolvedValue({ manifest: { personId: "person" }, personalRoot: { identity: { personId: "person" }, workspaces: {
      board: { workspaceId: "board", documentId: "board", grantHash: "authenticated-grant", forgotten: false },
    } }, replicas: {}, capabilities: [] })
    ports.credential.mockResolvedValue(null)
  })

  it("Given a committed journal activation, when projection resumes, then it activates the authenticated transfer and refreshes local catalog", async () => {
    const guard = vi.fn()
    await prepareWorkspaceHistoryRecoveryProjection({ personId: "person", workspaceId: "board", recoveryId,
      manifest: { personId: "person" } as never, authority: null, credential: null, title: "Recovered board" }, guard)
    await resumeWorkspaceHistoryRecoveryProjection("person", guard)
    expect(ports.activate).toHaveBeenCalledOnce()
    expect(ports.currentRoot).toHaveBeenCalledWith(expect.anything(), expect.anything(), "board", "authenticated-grant")
    expect(ports.catalog).toHaveBeenCalledOnce()
    expect(ports.invalidate).toHaveBeenCalledWith("board")
  })

  it("Given an uncommitted workspace recovery ID, when startup resumes, then it leaves the durable intent untouched", async () => {
    ports.revision.mockReturnValue("e89177a4-5cae-46e1-86a1-bf0379d1de50")
    const guard = vi.fn()
    await prepareWorkspaceHistoryRecoveryProjection({ personId: "person", workspaceId: "board", recoveryId,
      manifest: { personId: "person" } as never, authority: null, credential: null, title: "Recovered board" }, guard)
    vi.clearAllMocks()
    await resumeWorkspaceHistoryRecoveryProjection("person", guard)
    expect(ports.activate).not.toHaveBeenCalled()
    expect(ports.currentRoot).not.toHaveBeenCalled()
  })

  it("Given a changed durable identity, when projection resumes, then it refuses all secondary writes", async () => {
    const guard = vi.fn()
    await prepareWorkspaceHistoryRecoveryProjection({ personId: "person", workspaceId: "board", recoveryId,
      manifest: { personId: "person" } as never, authority: null, credential: null, title: "Recovered board" }, guard)
    ports.current.mockResolvedValue(JSON.stringify({ identity: { personId: "replacement" } }))
    vi.clearAllMocks()
    await expect(resumeWorkspaceHistoryRecoveryProjection("person", guard)).rejects.toThrow()
    expect(ports.activate).not.toHaveBeenCalled()
    expect(ports.putCredential).not.toHaveBeenCalled()
  })

  it("Given a secondary-store interruption, when startup resumes again, then retain and complete the same projection intent", async () => {
    const guard = vi.fn()
    await prepareWorkspaceHistoryRecoveryProjection({ personId: "person", workspaceId: "board", recoveryId,
      manifest: { personId: "person" } as never, authority: null, credential: null, title: "Recovered board" }, guard)
    ports.activate.mockRejectedValueOnce(new Error("secondary store interrupted"))
    await expect(resumeWorkspaceHistoryRecoveryProjection("person", guard)).rejects.toThrow("secondary store interrupted")
    expect(ports.records.size).toBe(1)
    ports.activate.mockResolvedValue(undefined)
    await resumeWorkspaceHistoryRecoveryProjection("person", guard)
    expect(ports.activate).toHaveBeenCalledTimes(2)
    expect(ports.records.values().next().value).toMatchObject({ status: "completed" })
  })

  it("Given a transport secret changes after recovery preparation, when projecting, then preserve that current secret", async () => {
    const guard = vi.fn(), recoveryId = "00000000-0000-4000-8000-000000000001"
    ports.revision.mockReturnValue(recoveryId)
    ports.credential.mockResolvedValue({ workspaceId: "board", ownerPersonId: "owner", epoch: 2, transportSecret: "current-secret" })
    await prepareWorkspaceHistoryRecoveryProjection({ personId: "person", workspaceId: "board", recoveryId,
      manifest: { personId: "person" } as never, authority: null,
      credential: { workspaceId: "board", ownerPersonId: "owner", epoch: 2, transportSecret: "older-secret" } as never,
      title: "Recovered board" }, guard)
    await resumeWorkspaceHistoryRecoveryProjection("person", guard)
    expect(ports.putCredential).toHaveBeenCalledWith(expect.objectContaining({ transportSecret: "current-secret" }))
  })

  it("Given admitted newer ownership evidence, when projecting credentials, then use the peer-store ownership CAS", async () => {
    const previous = { version: 1, workspaceId: "board", ownerPersonId: "previous-owner", epoch: 2,
      transportSecret: "current-transport-secret", updatedAt: "2026-01-01T00:00:00.000Z" }
    const next = { ...previous, ownerPersonId: "new-owner", epoch: 3 }
    ports.credential.mockResolvedValue(previous)
    const guard = vi.fn()
    await prepareWorkspaceHistoryRecoveryProjection({ personId: "person", workspaceId: "board", recoveryId,
      manifest: { personId: "person" } as never, authority: null, credential: next as never, title: "Recovered board" }, guard)
    await resumeWorkspaceHistoryRecoveryProjection("person", guard)
    expect(ports.transferCredential).toHaveBeenCalledWith("previous-owner", next, undefined)
    expect(ports.putCredential).not.toHaveBeenCalled()
  })
})
