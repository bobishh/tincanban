import { readFile } from "node:fs/promises"
import * as Automerge from "@automerge/automerge/slim"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import { withWorkspaceMutation } from "../workspaceMutation"
import type * as StorageJournal from "../storageJournal"
import { encodeBlindBytes } from "@meta-uber/mesh-replication/rusty-replica"

const f = vi.hoisted(() => ({ publication: undefined as unknown, verify: vi.fn(), stage: vi.fn(), activate: vi.fn(), commit: vi.fn(), active: undefined as unknown }))
vi.mock("./historyBaselinePublicationRepository", () => ({ readPreparedHistoryPublication: async () => f.publication,
  readPublishedHistoryBaseline: async () => undefined, commitPreparedHistoryPublication: (...args: unknown[]) => f.commit(...args) }))
vi.mock("./receivedHistoryBaselineRepository", () => ({ createReceivedHistoryBaselineRepository: () => ({ readActive: async () => f.active,
  readStaged: async () => undefined, stage: (...args: unknown[]) => f.stage(...args), activate: (...args: unknown[]) => f.activate(...args) }) }))
vi.mock("../product-replica/historyBaselineReceiver", () => ({ verifyReceivedWireHistoryBaseline: (...args: unknown[]) => f.verify(...args) }))
vi.mock("../storageJournal", async importOriginal => ({ ...(await importOriginal() as typeof StorageJournal),
  readWorkspaceBasisSnapshot: async () => null }))
vi.mock("./historyBaselineStartup", () => ({ reverifyActiveHistoryForWorkspace: async () => null }))
vi.mock("@meta-uber/mesh-replication/history-archive-remote", () => ({ createArchiveRemote: () => ({ download: vi.fn() }) }))
import { resumePublishedHistoryBaseline } from "./historyBaselinePublicationResume"

beforeAll(async () => { await Automerge.initializeWasm(new Uint8Array(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"))) })
beforeEach(() => { vi.clearAllMocks(); f.active = undefined })
function fixture() {
  const document = Automerge.from({ id: "resume-board", title: "Original" }), bytes = Automerge.save(document)
  const scope = { scopeId: "resume-board", servicePublicKey: "A".repeat(43), policyRevision: 1 }
  f.publication = { wire: { signedJson: encodeBlindBytes(new TextEncoder().encode(JSON.stringify({ payload: {
    transitionId: "transition", baselineId: "baseline", previousBaselineId: null, sourceHeads: Automerge.getHeads(document), storage: { keyEpoch: 1, authority: scope } } }))) } }
  f.verify.mockResolvedValue({ free: vi.fn() }); f.stage.mockResolvedValue("stage")
  const input = { tincanban: { readWorkspaceBytes: async () => bytes.slice(), getCurrentProfile: () => ({ identity: { personId: "owner" } }) } as never,
    config: { ...scope, workspaceId: "resume-board", origin: "https://rusty.example", contentKey: "A".repeat(43), keyEpoch: 1,
      readToken: "read", writeToken: "write", cursor: 0, lastUploaded: "" }, transitionId: "transition", previousBaselineId: null,
    scopeAuthority: {}, ensureCurrent: () => {}, ensureNativeCurrent: () => {} }
  return { document, input }
}
it("Given a retained candidate, when storage checkpoint is pending, then hold source check through activation against concurrent workspace mutation", async () => {
  const { document, input } = fixture(), order: string[] = []
  let release!: () => void, started!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve }), began = new Promise<void>(resolve => { started = resolve })
  f.commit.mockImplementation(async () => { order.push("publication") }); f.activate.mockImplementation(async () => { order.push("activate") })
  const resumed = resumePublishedHistoryBaseline({ ...input, checkpointBeforeActivation: async () => { order.push("checkpoint"); started(); await waiting } })
  await began
  const mutation = withWorkspaceMutation(input.config.workspaceId, async () => { order.push("concurrent mutation") })
  await Promise.resolve(); expect(order).toEqual(["checkpoint"])
  release(); await resumed; await mutation
  expect(order).toEqual(["checkpoint", "publication", "activate", "concurrent mutation"])
  Automerge.free(document)
})
it("Given source heads changed before any checkpoint delivery, when retrying a retained candidate, then refuse its obsolete fence before signing or activation", async () => {
  const { document, input } = fixture(), checkpoint = vi.fn()
  const next = Automerge.change(document, draft => { draft.title = "New signed original" })
  input.tincanban = { ...input.tincanban as object, readWorkspaceBytes: async () => Automerge.save(next) } as never
  await expect(resumePublishedHistoryBaseline({ ...input, checkpointBeforeActivation: checkpoint })).rejects.toThrow("board changed")
  expect(checkpoint).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
  Automerge.free(next)
})
