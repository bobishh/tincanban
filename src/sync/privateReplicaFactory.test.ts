import { ref } from "vue"
import { beforeEach, expect, test, vi } from "vitest"
import type { BlindReplicaConfig } from "./blindReplication"

const mocks = vi.hoisted(() => ({
  pending: vi.fn(), create: vi.fn(), resume: vi.fn(), configurations: vi.fn(), conflicts: vi.fn(), persist: vi.fn(),
}))

vi.mock("./privateReplicaRepository", () => ({ readReplicaWriterUpgrade: mocks.pending,
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
  expect(mocks.create).not.toHaveBeenCalled()
})
