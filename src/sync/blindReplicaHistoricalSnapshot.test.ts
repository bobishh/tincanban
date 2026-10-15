import * as Automerge from "@automerge/automerge/slim"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import { readFile } from "node:fs/promises"

const ports = vi.hoisted(() => ({ basis: undefined as unknown, verify: vi.fn(), dispose: vi.fn(), download: vi.fn() }))
vi.mock("../storage", () => ({ defaultStorage: { getVerifiedReceivedHistoryBaseline: async () => ports.basis } }))
vi.mock("./historyBaselineStartup", () => ({ reverifyActiveHistoryForWorkspace: async () => undefined }))
vi.mock("@meta-uber/mesh-replication/history-archive-remote", () => ({ createArchiveRemote: () => ({ download: ports.download }) }))
vi.mock("./historyArchiveReader", () => ({ createHistoryArchiveReader: () => ({ verifyArchivedSnapshot: ports.verify, dispose: ports.dispose }) }))
import { isCoveredBlindHistoricalSnapshot } from "./blindReplicaHistoricalSnapshot"
import type { BlindReplicaConfig } from "./blindReplication"

beforeAll(async () => { await Automerge.initializeWasm(new Uint8Array(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"))) })
beforeEach(() => { ports.basis = undefined; vi.clearAllMocks(); ports.verify.mockResolvedValue(undefined) })
function fixture() {
  const original = Automerge.from({ id: "workspace", title: "Original" })
  const compact = Automerge.from({ id: "workspace", title: "Compact" })
  const config = { workspaceId: "workspace", scopeId: "workspace", origin: "https://rusty.example", servicePublicKey: "pin",
    policyRevision: 2, keyEpoch: 1, contentKey: "A".repeat(43) } as BlindReplicaConfig
  ports.basis = { document: () => Automerge.save(compact), envelope: () => ({ payload: { workspaceId: "workspace", baselineId: "baseline",
    storage: { keyEpoch: 1, authority: { scopeId: "workspace", servicePublicKey: "pin", policyRevision: 1 } } } }) }
  const guardIdentity = vi.fn(), ensureCurrent = vi.fn(async () => {})
  return { original, compact, input: { config, owner: "owner", document: Automerge.save(original), guardIdentity, ensureCurrent } }
}
it("Given an installed compact basis and an old Rusty prefix, when Native confirms every original, then acknowledge without merging or replacing the basis", async () => {
  const f = fixture()
  try {
    await expect(isCoveredBlindHistoricalSnapshot(f.input)).resolves.toBe(true)
    expect(ports.verify).toHaveBeenCalledWith(f.input.document)
    expect(ports.dispose).toHaveBeenCalledOnce()
    expect(f.input.ensureCurrent).toHaveBeenCalled()
  } finally { Automerge.free(f.original); Automerge.free(f.compact) }
})
it("Given an uncaptured historical change, when archive verification refuses it, then keep the cold cursor blocked rather than discard that change", async () => {
  const f = fixture(); ports.verify.mockRejectedValue(new Error("Original absent from signed archive"))
  try {
    await expect(isCoveredBlindHistoricalSnapshot(f.input)).rejects.toThrow("Original absent from signed archive")
    expect(ports.dispose).toHaveBeenCalledOnce()
  } finally { Automerge.free(f.original); Automerge.free(f.compact) }
})
it("Given a current compact-root snapshot, when receiving it, then preserve ordinary Native tail admission", async () => {
  const f = fixture(); f.input.document = Automerge.save(f.compact)
  try {
    await expect(isCoveredBlindHistoricalSnapshot(f.input)).resolves.toBe(false)
    expect(ports.verify).not.toHaveBeenCalled()
  } finally { Automerge.free(f.original); Automerge.free(f.compact) }
})
it("Given no admitted compact basis, when receiving an original snapshot, then preserve ordinary causal admission", async () => {
  const f = fixture(); ports.basis = undefined
  try { await expect(isCoveredBlindHistoricalSnapshot(f.input)).resolves.toBe(false); expect(ports.verify).not.toHaveBeenCalled() }
  finally { Automerge.free(f.original); Automerge.free(f.compact) }
})
