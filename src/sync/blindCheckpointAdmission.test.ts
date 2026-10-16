import { readFile } from "node:fs/promises"
import { afterEach, beforeAll, expect, test, vi } from "vitest"
import { change, init, save, getChangesMetaSince, initializeWasm } from "@automerge/automerge/slim"
import { assertWorkspaceWritesAllowed } from "../stateCausalAdmission"
import { checkpointAdmissionReady, checkpointHooks } from "./blindCheckpointAdmission"
import { readReplicaWriterUpgrade } from "./privateReplicaRepository"
import type { BlindReplicaConfig } from "./blindReplication"
import { stateRuntime } from "../stateContext"
import { defaultStorage } from "../storage"
import type { StoredCausalEvidence } from "../storageJournal"
import type { useTincanban } from "../state"
vi.mock("../stateCausalAdmission", () => ({ assertWorkspaceWritesAllowed: vi.fn(async () => {}) }))
vi.mock("./privateReplicaRepository", () => ({ readReplicaWriterUpgrade: vi.fn(async () => undefined) }))
beforeAll(async () => { await initializeWasm(new Uint8Array(await readFile("node_modules/@automerge/automerge/dist/automerge.wasm"))) })
afterEach(() => { vi.restoreAllMocks(); stateRuntime.ready.value = false; stateRuntime.pendingWrites = 0 })

function fixture() {
  const raw = change(init<{ id: string; ownerPersonId: string; title: string }>(), value => { value.id = "board"; value.ownerPersonId = "owner"; value.title = "Complete history" })
  const evidence: StoredCausalEvidence = { bytes: save(raw), decisions: getChangesMetaSince(raw, []).map(value => ({ hash: value.hash, status: { type: "admitted", role: "owner" } })) }
  vi.spyOn(defaultStorage, "loadCausalEvidence").mockImplementation(async () => evidence)
  stateRuntime.ready.value = true
  const app = { getCurrentProfile: () => ({ identity: { personId: "owner" } }), readWorkspaceDoc: async () => ({ ownerPersonId: "owner" }), causalReviewError: { value: "" } } as unknown as ReturnType<typeof useTincanban>
  return { raw, evidence, app }
}

test("Given a complete durable admitted raw journal, checkpoint admission permits only a snapshot covering that causal history", async () => {
  const { evidence, app } = fixture()
  expect(await checkpointAdmissionReady(app, "board", evidence.bytes)).toBe(true)
  expect(await checkpointAdmissionReady(app, "board", save(init()))).toBe(false)
  evidence.decisions = []
  expect(await checkpointAdmissionReady(app, "board")).toBe(false)
})

test("Dismissed or resolved quarantined history and pending history remain retention blockers", async () => {
  const { evidence, app } = fixture()
  const hash = evidence.decisions[0]!.hash
  evidence.dismissedHashes = [hash]
  evidence.resolvedReviews = [{ sourceHash: hash, authorizedChangeHash: "replacement" }]
  for (const type of ["pending", "quarantined"] as const) {
    evidence.decisions[0] = { hash, status: { type, reason: "Unadmitted branch" } }
    expect(await checkpointAdmissionReady(app, "board")).toBe(false)
  }
})

test("Local writes still in flight and changed ownership prevent checkpoint deletion", async () => {
  const { app } = fixture()
  stateRuntime.pendingWrites = 1
  expect(await checkpointAdmissionReady(app, "board")).toBe(false)
  stateRuntime.pendingWrites = 0
  vi.spyOn(app, "readWorkspaceDoc").mockResolvedValue({ ownerPersonId: "other" } as never)
  expect(await checkpointAdmissionReady(app, "board")).toBe(false)
})

test("Pending ownership confirmation blocks cleanup without making ordinary replication unavailable", async () => {
  const { app } = fixture()
  vi.mocked(assertWorkspaceWritesAllowed).mockRejectedValueOnce(new Error("Ownership transfer awaiting confirmation"))
  expect(await checkpointAdmissionReady(app, "board")).toBe(false)
})

test("Given locally active storage policy but unfinished automation confirmation, when considering destructive checkpoint cleanup, then defer deletion until maintenance finishes", async () => {
  const { app } = fixture()
  vi.mocked(readReplicaWriterUpgrade).mockResolvedValueOnce({ localActivated: true } as never)
  const hooks = checkpointHooks(app, { workspaceId: "board" } as BlindReplicaConfig, () => {})
  expect(await hooks.checkpointAllowed!()).toBe(false)
  expect(await hooks.checkpointAllowed!()).toBe(true)
})
