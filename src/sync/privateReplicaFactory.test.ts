import { ref } from "vue"
import { beforeEach, expect, test, vi } from "vitest"
import type { BlindReplicaConfig } from "./blindReplication"

const mocks = vi.hoisted(() => ({
  pending: vi.fn(), create: vi.fn(), resume: vi.fn(), configurations: vi.fn(), conflicts: vi.fn(), persist: vi.fn(),
}))

vi.mock("./privateReplicaRepository", () => ({ privateReplicaBinding: () => "fixture-binding", readReplicaWriterUpgrade: mocks.pending,
  getPrivateReplicaConfigurations: mocks.configurations, getPrivateReplicaConflictSummaries: mocks.conflicts,
  persistPrivateReplicaProgress: mocks.persist }))
vi.mock("./blindReplicaStore", () => ({ createBlindReplica: mocks.create }))
vi.mock("./workspaceReplicaWriter", () => ({ ensureWorkspaceReplicaWriter: mocks.resume }))

const config: BlindReplicaConfig = {
  workspaceId: "workspace-route", origin: "https://rusty.example", scopeId: "scope-route",
  contentKey: "A".repeat(43), readToken: "B".repeat(43), writeToken: "C".repeat(43),
  servicePublicKey: "D".repeat(43), policyRevision: 3, keyEpoch: 1, cursor: 0, lastUploaded: "",
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.pending.mockResolvedValue(undefined)
  mocks.create.mockReturnValue({ sync: vi.fn(async () => true) })
  mocks.resume.mockResolvedValue({ ...config, minimumWriterVersion: 2 })
})

test("Given retained legacy participant access, when storage resolves, then wait for owner reissue without constructing a failing client or discarding settings", async () => {
  const { resolvePrivateReplica } = await import("./privateReplicaFactory")
  const legacy = { ...config, boardAccess: { authorization: { payload: { version: 1 } } } } as BlindReplicaConfig
  const session = { owner: "editor", guard: vi.fn(), configs: ref([legacy]), cache: new Map(), reload: vi.fn(async () => {}) }
  const app = { getCurrentProfile: () => ({ identity: { personId: "editor" } }) }
  await expect(resolvePrivateReplica(app as never, legacy, session as never)).rejects.toMatchObject({ code: "participant_storage_access_pending" })
  expect(mocks.create).not.toHaveBeenCalled()
  expect(session.configs.value).toEqual([legacy])
  const upgraded = { ...legacy, boardAccess: { authorization: { payload: { version: 2 } } } } as BlindReplicaConfig
  await expect(resolvePrivateReplica(app as never, upgraded, session as never)).resolves.toBeDefined()
  expect(mocks.create).toHaveBeenCalledOnce()
})

test("Given no durable writer transition, when a legacy replica resolves and syncs, then maintenance is queued after ordinary sync instead of awaited", async () => {
  const { resolvePrivateReplica } = await import("./privateReplicaFactory")
  const sync = vi.fn(async () => true)
  mocks.create.mockReturnValue({ sync })
  const queueWriterMaintenance = vi.fn()
  const cache = new Map()
  const session = { owner: "owner", guard: vi.fn(), configs: ref([config]), cache,
    reload: vi.fn(async () => {}), queueWriterMaintenance }
  const app = { getCurrentProfile: () => ({ identity: { personId: "owner" } }) }

  const replica = await resolvePrivateReplica(app as never, config, session as never)
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(await replica.sync()).toBe(true)
  expect(sync).toHaveBeenCalledOnce()
  expect(queueWriterMaintenance).toHaveBeenCalledOnce()
})

test("Given a durable writer transition, when strict resume fails, then do not construct a writer that can bypass it", async () => {
  const { resolvePrivateReplica } = await import("./privateReplicaFactory")
  const transition = { id: "pending-transition" }
  mocks.pending.mockResolvedValue(transition)
  mocks.resume.mockRejectedValue(new Error("Worker discovery unavailable"))
  const session = { owner: "owner", guard: vi.fn(), configs: ref([config]), cache: new Map(), reload: vi.fn(async () => {}) }
  const app = { getCurrentProfile: () => ({ identity: { personId: "owner" } }) }

  await expect(resolvePrivateReplica(app as never, config, session as never)).rejects.toThrow("Worker discovery unavailable")
  expect(mocks.resume).toHaveBeenCalledOnce()
  expect(mocks.resume).toHaveBeenCalledWith(app, config, session.guard, { storageOnly: true })
  expect(mocks.create).not.toHaveBeenCalled()
})

test("Given locally activated Rusty policy and unfinished automation confirmation, when resolving and syncing, then never await automation or its maintenance lock", async () => {
  const { resolvePrivateReplica } = await import("./privateReplicaFactory")
  mocks.pending.mockResolvedValue({ id: "pending-transition", localActivated: true })
  mocks.resume.mockImplementation(() => new Promise(() => {}))
  const sync = vi.fn(async () => true)
  mocks.create.mockReturnValue({ sync })
  const queueWriterMaintenance = vi.fn()
  const current = { ...config, minimumWriterVersion: 2 as const }
  const session = { owner: "owner", guard: vi.fn(), configs: ref([current]), cache: new Map(),
    reload: vi.fn(async () => {}), queueWriterMaintenance }
  const app = { getCurrentProfile: () => ({ identity: { personId: "owner" } }) }
  const replica = await resolvePrivateReplica(app as never, current, session as never)
  expect(await replica.sync()).toBe(true)
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(sync).toHaveBeenCalledOnce()
  expect(queueWriterMaintenance).toHaveBeenCalledWith(current)
})

test("Given locally active policy and a newer signed receipt retained after interruption, when resolving storage, then recover only its exact Rusty policy before constructing the writer", async () => {
  const { resolvePrivateReplica } = await import("./privateReplicaFactory")
  const current = { ...config, minimumWriterVersion: 2 as const }
  const updated = { ...current, policyRevision: current.policyRevision + 1 }
  mocks.pending.mockResolvedValue({ id: "retained-policy-receipt", localActivated: true,
    confirmed: { payload: { revision: updated.policyRevision } } })
  mocks.resume.mockResolvedValue(updated)
  const session = { owner: "owner", guard: vi.fn(), configs: ref([current]), cache: new Map(), reload: vi.fn(async () => {}) }
  const app = { getCurrentProfile: () => ({ identity: { personId: "owner" } }) }
  await resolvePrivateReplica(app as never, current, session as never)
  expect(mocks.resume).toHaveBeenCalledWith(app, current, session.guard, { storageOnly: true })
  expect(mocks.create.mock.calls[0]?.[0]).toEqual(updated)
})

test("Given concurrent requests for the same replica, when its adapter loads, then construct one client and share its operation queue", async () => {
  const { resolvePrivateReplica } = await import("./privateReplicaFactory")
  const session = { owner: "owner", guard: vi.fn(), configs: ref([config]), cache: new Map(), reload: vi.fn(async () => {}) }
  const app = { getCurrentProfile: () => ({ identity: { personId: "owner" } }) }
  const [left, right] = await Promise.all([
    resolvePrivateReplica(app as never, config, session as never),
    resolvePrivateReplica(app as never, config, session as never),
  ])
  expect(left).toBe(right)
  expect(mocks.create).toHaveBeenCalledOnce()
})
