import { beforeEach, expect, it, vi } from "vitest"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"
import { WorkspaceUnavailableError } from "../workspaceAvailability"

const ports = vi.hoisted(() => ({ validate: vi.fn(), authority: vi.fn(), previous: vi.fn(), merge: vi.fn(), download: vi.fn(), route: vi.fn(),
  baseline: vi.fn(), snapshot: vi.fn(), causal: vi.fn(), changes: vi.fn(), revision: vi.fn(), publication: vi.fn(), active: vi.fn(), archiveFetch: undefined as unknown }))
vi.mock("@meta-uber/mesh-transport/wasm", () => ({ WasmStateCore: { validateScopeAuthority: (...args: unknown[]) => ports.validate(...args) } }))
vi.mock("./peerStore", () => ({ peerStore: { getWorkspaceAuthority: (...args: unknown[]) => ports.authority(...args), getWorkspaceCredential: async () => undefined } }))
vi.mock("../storage", () => ({ defaultStorage: { getVerifiedReceivedHistoryBaseline: (...args: unknown[]) => ports.previous(...args),
  hasCausalEvidence: (...args: unknown[]) => ports.causal(...args), listChanges: (...args: unknown[]) => ports.changes(...args),
  readWorkspaceRevision: (...args: unknown[]) => ports.revision(...args) } }))
vi.mock("../storageJournal", () => ({ readWorkspaceBasisSnapshot: (...args: unknown[]) => ports.snapshot(...args) }))
vi.mock("./receivedHistoryBaselineRepository", () => ({ createReceivedHistoryBaselineRepository: () => ({ readActive: (...args: unknown[]) => ports.active(...args),
  recordActiveWireRoute: (...args: unknown[]) => ports.route(...args) }) }))
vi.mock("./browserHistoryBaselineReceive", () => ({ receiveBrowserHistoryBaseline: (...args: unknown[]) => ports.baseline(...args) }))
vi.mock("./historyBaselinePublicationRepository", () => ({ readPublishedHistoryBaseline: (...args: unknown[]) => ports.publication(...args) }))
vi.mock("@meta-uber/mesh-replication/history-archive-remote", () => ({ createArchiveRemote: (_access: unknown, remote: { fetch: unknown }) => {
  ports.archiveFetch = remote.fetch
  return { download: ports.download }
} }))
vi.mock("../product-replica/historyBaselineReceiver", () => ({ parseWireHistoryBaseline: (value: unknown) => value }))
import { receiveBlindReplicaHistory, type ReceiveContext } from "./blindReplicaHistoryReceive"

beforeEach(() => { vi.clearAllMocks(); ports.archiveFetch = undefined; ports.validate.mockReset().mockReturnValue({ scopeId: "workspace-board" });
  ports.merge.mockResolvedValue(undefined); ports.baseline.mockResolvedValue(undefined); ports.snapshot.mockResolvedValue(undefined)
  ports.causal.mockResolvedValue(false); ports.changes.mockResolvedValue([]); ports.revision.mockResolvedValue(undefined); ports.publication.mockResolvedValue(undefined)
  ports.active.mockResolvedValue(undefined) })
function fixture() {
  const signed = new Uint8Array([1, 2, 3]), document = new Uint8Array([4, 5]), authorization = { exact: "proof" }
  const config = { workspaceId: "workspace-board", scopeId: "opaque-rusty-storage", servicePublicKey: "service-pin", policyRevision: 2 }
  const storage = { authority: { scopeId: config.scopeId, servicePublicKey: config.servicePublicKey, policyRevision: 1 } }
  const previous = { originalJson: () => signed.slice(), envelope: () => ({ payload: { workspaceId: config.workspaceId,
    baselineId: "baseline-current", storage } }) }
  ports.authority.mockResolvedValue({ scopeAuthoritySnapshot: { signed: "workspace ledger" } }); ports.previous.mockResolvedValue(previous)
  const context = { config, owner: "owner", guardIdentity: vi.fn(), readReplicaProgress: vi.fn(async () => ({ version: 1, binding: "fresh", generation: 0, cursor: 0, lastUploaded: "" })), readSnapshotRevision: vi.fn(),
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

it("Given no local workspace document, snapshot, causal evidence, or baseline, when receiving compacted history, then use an empty local basis", async () => {
  const f = fixture()
  ports.previous.mockResolvedValue(undefined)
  f.context.tincanban.readWorkspaceBytes = vi.fn(async () => { throw new WorkspaceUnavailableError() })
  ports.baseline.mockImplementationOnce(async (input: { ports: { readLocal(): Promise<unknown> } }) => input.ports.readLocal())

  await receiveBlindReplicaHistory(f.context, f.context.config.workspaceId, f.document, f.authorization, f.wire)

  expect(ports.baseline).toHaveBeenCalledOnce()
  await expect(ports.baseline.mock.results[0]!.value).resolves.toMatchObject({ bytes: new Uint8Array(), heads: [], pending: false })
  expect(ports.snapshot).toHaveBeenCalledWith(f.context.config.workspaceId)
  expect(ports.causal).toHaveBeenCalledWith(f.context.config.workspaceId)
})

it.each([
  ["snapshot", async (): Promise<void> => { ports.snapshot.mockResolvedValueOnce({ workspaceId: "workspace-board", bytes: new Uint8Array([1]) }) }],
  ["causal journal", async (): Promise<void> => { ports.causal.mockResolvedValueOnce(true) }],
  ["local change journal", async (): Promise<void> => { ports.changes.mockResolvedValueOnce([{ changeHash: "local-change" }]) }],
  ["revision marker", async (): Promise<void> => { ports.revision.mockResolvedValueOnce("revision-without-document") }],
  ["published history baseline", async (): Promise<void> => { ports.publication.mockResolvedValueOnce({ baselineId: "published-baseline" }) }],
  ["existing verified baseline", async (): Promise<void> => undefined],
] as const)("Given no readable document but existing %s, when compacted history arrives, then preserve the storage failure", async (_state, prepare) => {
  const f = fixture()
  f.context.tincanban.readWorkspaceBytes = vi.fn(async () => { throw new WorkspaceUnavailableError() })
  if (_state !== "existing verified baseline") ports.previous.mockResolvedValue(undefined)
  else f.wire.signedJson = encodeBlindBytes(new Uint8Array([9]))
  await prepare()
  ports.baseline.mockImplementationOnce(async (input: { ports: { readLocal(): Promise<unknown> } }) => input.ports.readLocal())

  await expect(receiveBlindReplicaHistory(f.context, f.context.config.workspaceId, f.document, f.authorization, f.wire))
    .rejects.toMatchObject({ code: "workspace-unavailable" })
  expect(ports.baseline).toHaveBeenCalledOnce()
})

it("Given no readable document but a staged Rusty outbox, when compacted history arrives, then preserve the pending write", async () => {
  const f = fixture()
  ports.previous.mockResolvedValue(undefined)
  f.context.readReplicaProgress = vi.fn(async () => ({ version: 1, binding: "fresh", generation: 1, cursor: 0,
    lastUploaded: "", pending: { requestId: "pending", hash: "hash", bytes: 1, object: "opaque" } })) as unknown as ReceiveContext["readReplicaProgress"]
  f.context.tincanban.readWorkspaceBytes = vi.fn(async () => { throw new WorkspaceUnavailableError() })
  ports.baseline.mockImplementationOnce(async (input: { ports: { readLocal(): Promise<unknown> } }) => input.ports.readLocal())

  await expect(receiveBlindReplicaHistory(f.context, f.context.config.workspaceId, f.document, f.authorization, f.wire))
    .rejects.toThrow(/original Rusty outbox/i)
  expect(ports.baseline).toHaveBeenCalledOnce()
})
