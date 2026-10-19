import { describe, expect, it, vi } from "vitest"
import type { WasmVerifiedReceivedHistoryBaseline } from "@meta-uber/mesh-transport/wasm"
import { WorkspaceStorage, type WorkspaceTransactionContext } from "../storage"
import { receiveBrowserHistoryBaseline } from "./browserHistoryBaselineReceive"

function fixture() {
  const candidate = { envelope: () => ({ payload: { workspaceId: "board-a", baselineId: "A".repeat(43), storage: {
    authority: { scopeId: "scope-a", servicePublicKey: "S".repeat(43), policyRevision: 2 }, keyEpoch: 1,
  } } }), free: vi.fn() }
  const active = { baselineId: "prior" }
  const repository = { readActive: vi.fn(async () => active), readStaged: vi.fn(async () => undefined),
    stage: vi.fn(async () => "stage-a"), activate: vi.fn(async () => {}) }
  const storage = new WorkspaceStorage()
  const ports = { repository, workspaceTransaction: <T>(operation: (context: WorkspaceTransactionContext) => Promise<T>) =>
    storage.withWorkspaceTransaction("board-a", operation),
    ensureCurrent: vi.fn(), readLocal: vi.fn(async () => ({
      bytes: new Uint8Array([1]), heads: ["a".repeat(64)], revision: "local-1", catalogRevision: "catalog-1", pending: false,
    })),
    verify: vi.fn(async () => candidate as unknown as WasmVerifiedReceivedHistoryBaseline), coversHeads: vi.fn(async () => {}), readExpectedSnapshot: vi.fn(async () => null),
    accept: vi.fn(async () => {}),
    merge: vi.fn(async () => {}) }
  return { candidate, repository, ports }
}
const config = { workspaceId: "board-a", scopeId: "scope-a", servicePublicKey: "S".repeat(43), policyRevision: 2,
  keyEpoch: 2, contentKey: "K".repeat(43), origin: "https://rusty.example" } as never

describe("browser received history baseline", () => {
  it("Given an admitted scope and stable local branch, when a covered baseline arrives, then stage and activate it before shared admission", async () => {
    const { candidate, repository, ports } = fixture()
    await receiveBrowserHistoryBaseline({ workspaceId: "board-a", config: { workspaceId: "board-a", scopeId: "scope-a", servicePublicKey: "S".repeat(43),
      policyRevision: 2, keyEpoch: 2, contentKey: "K".repeat(43), origin: "https://rusty.example" } as never,
      wire: {}, document: new Uint8Array([2]), authorization: { signed: true }, trustedScopeAuthority: { admitted: true },
      fetch: { download: vi.fn(), ensureCurrent: vi.fn() } as never, ports })
    expect(ports.verify).toHaveBeenCalledOnce()
    expect(ports.coversHeads.mock.calls[0]?.slice(0, 2)).toEqual([candidate, ["a".repeat(64)]])
    expect(repository.stage).toHaveBeenCalledOnce()
    expect(repository.activate).toHaveBeenCalledWith("stage-a", candidate, expect.objectContaining({ workspaceId: "board-a", capturedRevision: null, capturedBaselineId: null }))
    expect(ports.accept).toHaveBeenCalledWith(candidate)
    expect(ports.merge).toHaveBeenCalledWith(new Uint8Array([2]), { signed: true }, candidate)
  })

  it("Given an old uncertain outbox, when a compact baseline arrives, then reject before fetch, stage, or activation", async () => {
    const { repository, ports } = fixture()
    ports.readLocal.mockResolvedValue({ bytes: new Uint8Array([1]), heads: ["a".repeat(64)], revision: "local-1",
      catalogRevision: "catalog-1", pending: true })
    await expect(receiveBrowserHistoryBaseline({ workspaceId: "board-a", config,
      wire: {}, document: new Uint8Array([2]), authorization: {}, trustedScopeAuthority: {},
      fetch: { download: vi.fn(), ensureCurrent: vi.fn() } as never, ports })).rejects.toThrow(/outbox/i)
    expect(ports.verify).not.toHaveBeenCalled()
    expect(repository.stage).not.toHaveBeenCalled()
    expect(repository.activate).not.toHaveBeenCalled()
  })

  it("Given local state changes during remote verification, when the baseline returns, then preserve local history and skip activation", async () => {
    const { candidate, repository, ports } = fixture()
    ports.verify.mockImplementationOnce(async () => {
      ports.readLocal.mockResolvedValue({ bytes: new Uint8Array([9]), heads: ["b".repeat(64)], revision: "local-2",
        catalogRevision: "catalog-1", pending: false })
      return candidate as unknown as WasmVerifiedReceivedHistoryBaseline
    })
    await expect(receiveBrowserHistoryBaseline({ workspaceId: "board-a", config,
      wire: {}, document: new Uint8Array([2]), authorization: {}, trustedScopeAuthority: {},
      fetch: { download: vi.fn(), ensureCurrent: vi.fn() } as never, ports })).rejects.toThrow(/changed|branch/i)
    expect(repository.activate).not.toHaveBeenCalled()
    expect(ports.merge).not.toHaveBeenCalled()
  })

  it("Given an uncovered local head or failed merge, when a compact baseline arrives, then never acknowledge an unsafe projection", async () => {
    const uncovered = fixture()
    uncovered.ports.coversHeads.mockRejectedValueOnce(new Error("Owner baseline does not cover local branch"))
    await expect(receiveBrowserHistoryBaseline({ workspaceId: "board-a", config,
      wire: {}, document: new Uint8Array([2]), authorization: {}, trustedScopeAuthority: {},
      fetch: { download: vi.fn(), ensureCurrent: vi.fn() } as never, ports: uncovered.ports })).rejects.toThrow(/cover/i)
    expect(uncovered.repository.activate).not.toHaveBeenCalled()

    const failedAdmission = fixture()
    failedAdmission.ports.merge.mockRejectedValueOnce(new Error("shared causal admission rejected"))
    await expect(receiveBrowserHistoryBaseline({ workspaceId: "board-a", config,
      wire: {}, document: new Uint8Array([2]), authorization: {}, trustedScopeAuthority: {},
      fetch: { download: vi.fn(), ensureCurrent: vi.fn() } as never, ports: failedAdmission.ports })).rejects.toThrow(/admission/i)
    expect(failedAdmission.repository.activate).toHaveBeenCalledOnce()
    expect(failedAdmission.candidate.free).not.toHaveBeenCalled()
  })
})
