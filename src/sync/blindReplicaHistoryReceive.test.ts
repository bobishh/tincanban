import { beforeEach, expect, it, vi } from "vitest"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"

const ports = vi.hoisted(() => ({ validate: vi.fn(), authority: vi.fn(), previous: vi.fn(), merge: vi.fn(), download: vi.fn(), route: vi.fn(), archiveFetch: undefined as unknown }))
vi.mock("@meta-uber/mesh-transport/wasm", () => ({ WasmStateCore: { validateScopeAuthority: (...args: unknown[]) => ports.validate(...args) } }))
vi.mock("./peerStore", () => ({ peerStore: { getWorkspaceAuthority: (...args: unknown[]) => ports.authority(...args), getWorkspaceCredential: async () => undefined } }))
vi.mock("../storage", () => ({ defaultStorage: { getVerifiedReceivedHistoryBaseline: (...args: unknown[]) => ports.previous(...args) } }))
vi.mock("./receivedHistoryBaselineRepository", () => ({ createReceivedHistoryBaselineRepository: () => ({ readActive: async () => undefined,
  recordActiveWireRoute: (...args: unknown[]) => ports.route(...args) }) }))
vi.mock("@meta-uber/mesh-replication/history-archive-remote", () => ({ createArchiveRemote: (_access: unknown, remote: { fetch: unknown }) => {
  ports.archiveFetch = remote.fetch
  return { download: ports.download }
} }))
vi.mock("../product-replica/historyBaselineReceiver", () => ({ parseWireHistoryBaseline: (value: unknown) => value }))
import { receiveBlindReplicaHistory, type ReceiveContext } from "./blindReplicaHistoryReceive"

beforeEach(() => { vi.clearAllMocks(); ports.archiveFetch = undefined; ports.validate.mockReset().mockReturnValue({ scopeId: "workspace-board" }); ports.merge.mockResolvedValue(undefined) })
function fixture() {
  const signed = new Uint8Array([1, 2, 3]), document = new Uint8Array([4, 5]), authorization = { exact: "proof" }
  const config = { workspaceId: "workspace-board", scopeId: "opaque-rusty-storage", servicePublicKey: "service-pin", policyRevision: 2 }
  const storage = { authority: { scopeId: config.scopeId, servicePublicKey: config.servicePublicKey, policyRevision: 1 } }
  const previous = { originalJson: () => signed.slice(), envelope: () => ({ payload: { workspaceId: config.workspaceId,
    baselineId: "baseline-current", storage } }) }
  ports.authority.mockResolvedValue({ scopeAuthoritySnapshot: { signed: "workspace ledger" } }); ports.previous.mockResolvedValue(previous)
  const context = { config, owner: "owner", guardIdentity: vi.fn(), readReplicaProgress: vi.fn(async () => ({})), readSnapshotRevision: vi.fn(),
    scopeFetch: vi.fn(async () => new Response()) as unknown as ReceiveContext["scopeFetch"],
    tincanban: { mergeAuthorizedWorkspace: ports.merge } } as unknown as ReceiveContext
  return { context, previous, storage, document, authorization, wire: { signedJson: encodeBlindBytes(signed) } }
}
it("Given a workspace ledger and a distinct opaque Rusty storage scope, when the same v2 basis is polled again, then validate each binding against its own namespace and admit the tail", async () => {
  const f = fixture()
  await receiveBlindReplicaHistory(f.context, f.context.config.workspaceId, f.document, f.authorization, f.wire)
  expect(ports.archiveFetch).toBe(f.context.scopeFetch)
  expect(ports.route).toHaveBeenCalledWith("baseline-current", f.previous.originalJson(), f.wire)
  expect(ports.merge).toHaveBeenCalledWith("workspace-board", f.document, f.authorization, undefined, f.previous)
  expect(ports.download).not.toHaveBeenCalled()
})
it("Given the signed authority belongs to Rusty storage ID rather than this workspace, when receiving, then refuse the mismatched workspace ledger", async () => {
  const f = fixture(); ports.validate.mockReturnValue({ scopeId: f.context.config.scopeId })
  await expect(receiveBlindReplicaHistory(f.context, f.context.config.workspaceId, f.document, f.authorization, f.wire)).rejects.toThrow(/workspace.*authority|authority.*workspace/i)
  expect(ports.merge).not.toHaveBeenCalled()
})
it.each(["scope", "service", "revision"] as const)("Given the current basis has another pinned storage %s, when polling, then refuse even an identical signed descriptor", async mismatch => {
  const f = fixture()
  if (mismatch === "scope") f.storage.authority.scopeId = "other-storage"
  if (mismatch === "service") f.storage.authority.servicePublicKey = "other-service"
  if (mismatch === "revision") f.storage.authority.policyRevision = 3
  await expect(receiveBlindReplicaHistory(f.context, f.context.config.workspaceId, f.document, f.authorization, f.wire)).rejects.toThrow(/pinned.*Rusty|Rusty.*scope/i)
  expect(ports.merge).not.toHaveBeenCalled()
})
it("Given the workspace authority signature is invalid, when receiving current history, then preserve Native rejection before tail admission", async () => {
  const f = fixture(); ports.validate.mockImplementation(() => { throw new Error("Native scope signature invalid") })
  await expect(receiveBlindReplicaHistory(f.context, f.context.config.workspaceId, f.document, f.authorization, f.wire)).rejects.toThrow("Native scope signature invalid")
  expect(ports.merge).not.toHaveBeenCalled()
})
