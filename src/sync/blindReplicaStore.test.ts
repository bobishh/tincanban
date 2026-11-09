import { beforeEach, expect, it, vi } from "vitest"
import { type ReplicaState } from "@meta-uber/mesh-replication/replica-engine"
import { blindHash } from "./blindClient"
import type { BlindReplicaConfig } from "./blindReplication"
import { decodeBlindBytes, encryptBlindObject, type BlindObject } from "@meta-uber/mesh-replication/rusty-replica"
import { setReplicaPreference, getReplicaConfigurations } from "./privateReplicaRepository"
import type { AttachmentLocator } from "../product-replica"
import type { AttachmentCoverageStatus } from "./attachmentReplicationTypes"
import { meshTraceSnapshot } from "./meshTrace"

const captured = vi.hoisted(() => ({ stores: [] as Array<{ config: unknown; store: Record<string, unknown> }> }))
const background = vi.hoisted(() => ({
  run: vi.fn<(report: (states: AttachmentCoverageStatus[]) => void) => Promise<void>>(async () => {}),
}))

vi.mock("./blindReplication", () => ({
  BlindReplica: class {
    constructor(config: unknown, store: Record<string, unknown>) { captured.stores.push({ config, store }) }
  },
}))
vi.mock("./blindSnapshotRevision", () => ({ createBlindSnapshotRevision: () => async () => "snapshot-revision" }))
vi.mock("./blindCheckpointAdmission", () => ({ checkpointHooks: () => ({}) }))
vi.mock("./workspaceAttachmentReplicaStore", () => ({
  createWorkspaceAttachmentReplication: (_app: unknown, _config: unknown, _guard: unknown, _flush: unknown,
    report: (states: AttachmentCoverageStatus[]) => void) => ({ run: () => background.run(report) }),
}))

import { createBlindReplica } from "./blindReplicaStore"

const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

function makeConfig(): BlindReplicaConfig {
  return {
    origin: "https://rusty.example", scopeId: token, workspaceId: "workspace-a",
    servicePublicKey: token, readToken: token, writeToken: token, contentKey: token,
    policyRevision: 1, keyEpoch: 1, cursor: 0, lastUploaded: "",
  }
}

function makeTincanban(personId: string) {
  return {
    getCurrentProfile: () => ({ identity: { personId }, device: { deviceId: "device-a" } }),
    readWorkspaceBytes: async () => new Uint8Array([1]),
    mergeAuthorizedWorkspace: async () => {},
    readWorkspaceDoc: async () => ({ ownerPersonId: personId }),
    causalReviewError: { value: undefined },
  } as never
}

function repositoryPorts(store: Record<string, unknown>) {
  const read = store.readReplicaProgress
  const persist = store.persistReplicaProgress
  expect(store.replicaBinding).toEqual(expect.any(String))
  expect(read).toEqual(expect.any(Function))
  expect(persist).toEqual(expect.any(Function))
  return {
    read: read as () => Promise<ReplicaState<BlindObject>>,
    persist: persist as (expected: number, next: ReplicaState<BlindObject>) => Promise<void>,
  }
}

it("Given separate application clients for one scope, when a client is replaced or its identity changes while queued, then share the operation lock and recheck identity before work", async () => {
  const owner = crypto.randomUUID()
  const config = makeConfig()
  let current = true
  const guard = () => { if (!current) throw new Error("Identity changed") }
  createBlindReplica(config, makeTincanban(owner), guard, async () => {})
  createBlindReplica({ ...config, policyRevision: 2 }, makeTincanban(owner), guard, async () => {})
  type Exclusive = <T>(run: () => Promise<T>) => Promise<T>
  const first = captured.stores[0]!.store.runExclusive as Exclusive
  const second = captured.stores[1]!.store.runExclusive as Exclusive
  expect(first).toEqual(expect.any(Function))
  expect(second).toEqual(expect.any(Function))
  let release!: () => void
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const running = first(async () => { enter(); await new Promise<void>(resolve => { release = resolve }) })
  await entered
  const work = vi.fn(async () => {})
  const waiting = second(work)
  const rejected = expect(waiting).rejects.toThrow("Identity changed")
  current = false
  release()
  await running
  await rejected
  expect(work).not.toHaveBeenCalled()
})

beforeEach(() => { captured.stores.length = 0; background.run.mockReset() })

it("Given a slow attachment upload, when snapshot preparation schedules it, then metadata remains independent and repeated ticks share the same background work", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, makeConfig())
  const selected = (await getReplicaConfigurations(owner))[0]!
  let release!: () => void
  background.run.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve }) })
  createBlindReplica(selected, makeTincanban(owner), () => {}, async () => {})
  const schedule = captured.stores[0]!.store.prepareAttachments as () => Promise<void>
  expect(schedule).toEqual(expect.any(Function))
  await schedule()
  await vi.waitFor(() => expect(background.run).toHaveBeenCalledOnce())
  await schedule()
  expect(background.run).toHaveBeenCalledOnce()
  release()
})

it("Given a reopened replica, when board metadata is already current, then check attachments until a local pass has confirmed them", async () => {
  const owner = crypto.randomUUID()
  createBlindReplica(makeConfig(), makeTincanban(owner), () => {}, async () => {})
  const store = captured.stores[0]!.store
  const pending = store.attachmentRetryPending as () => Promise<boolean>
  const prepare = store.prepareAttachments as () => Promise<void>
  await expect(pending()).resolves.toBe(true)

  const failure = new Error("Could not read attachment work")
  background.run.mockImplementationOnce(async report => { report([]); throw failure })
    .mockImplementationOnce(async report => { report([]) })
  await prepare()
  await vi.waitFor(() => expect(meshTraceSnapshot().some(event => event.event === "mesh.rusty.attachments.failed")).toBe(true))
  await expect(pending()).resolves.toBe(true)
  await prepare()
  await vi.waitFor(async () => expect(await pending()).toBe(false))
  expect(background.run).toHaveBeenCalledTimes(2)
})

it("Given an application replica, when an upload is prepared and the factory is recreated, then private repository retains the exact pending ciphertext and request ID", async () => {
  const owner = crypto.randomUUID()
  const config = makeConfig()
  await setReplicaPreference(owner, config)
  const selected = (await getReplicaConfigurations(owner))[0]!
  const activePerson = owner
  const ensureIdentity = () => { if (activePerson !== owner) throw new Error("Identity changed") }
  const persistLegacy = async () => {}
  const app = makeTincanban(owner)

  createBlindReplica(selected, app, ensureIdentity, persistLegacy)
  const firstPorts = repositoryPorts(captured.stores[0]!.store)
  const before = await firstPorts.read()
  const key = decodeBlindBytes(config.contentKey)
  const plaintext = new Uint8Array([1])
  const object = await encryptBlindObject(config.scopeId, config.keyEpoch, key, plaintext)
  const requestId = crypto.randomUUID()
  const next: ReplicaState<BlindObject> = {
    ...before,
    generation: before.generation + 1,
    pending: { requestId, hash: await blindHash(plaintext), bytes: plaintext.length, object, revision: "snapshot-revision" },
  }

  await firstPorts.persist(before.generation, next)
  expect(await firstPorts.read()).toEqual(next)

  createBlindReplica(selected, app, ensureIdentity, persistLegacy)
  const reloaded = await repositoryPorts(captured.stores[1]!.store).read()
  expect(reloaded.pending).toEqual(next.pending)
})

it("Given the active identity changes, when replica progress is read or written, then old owner's progress stays inaccessible", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, makeConfig())
  const selected = (await getReplicaConfigurations(owner))[0]!
  let activePerson = owner
  const ensureIdentity = () => { if (activePerson !== owner) throw new Error("Identity changed") }
  createBlindReplica(selected, makeTincanban(owner), ensureIdentity, async () => {})
  const ports = repositoryPorts(captured.stores[0]!.store)
  const before = await ports.read()
  activePerson = crypto.randomUUID()

  await expect(ports.read()).rejects.toThrow("Identity changed")
  await expect(ports.persist(before.generation, { ...before, generation: before.generation + 1, cursor: 1 }))
    .rejects.toThrow("Identity changed")
  activePerson = owner
  expect(await ports.read()).toEqual(before)
})

it("Given an application replica, when its locator index is read or merged, then the adapter uses guarded durable attachment hooks", async () => {
  const owner = crypto.randomUUID()
  await setReplicaPreference(owner, makeConfig())
  const selected = (await getReplicaConfigurations(owner))[0]!
  let activePerson = owner
  const ensureIdentity = () => { if (activePerson !== owner) throw new Error("Identity changed") }
  createBlindReplica(selected, makeTincanban(owner), ensureIdentity, async () => {})
  const store = captured.stores[0]!.store
  const read = store.readAttachments as (workspaceId: string) => Promise<AttachmentLocator[]>
  const merge = store.mergeAttachments as (workspaceId: string, locators: unknown) => Promise<void>
  const revision = store.readAttachmentRevision as (workspaceId: string) => Promise<string | undefined>
  expect(read).toEqual(expect.any(Function))
  expect(merge).toEqual(expect.any(Function))
  expect(revision).toEqual(expect.any(Function))
  expect(await read(selected.workspaceId)).toEqual([])
  expect(await revision(selected.workspaceId)).toBeUndefined()

  const locator: AttachmentLocator = { version: 1, blobId: `sha256:${"A".repeat(43)}`,
    transferId: "transfer-one", manifestId: "B".repeat(43) }
  await merge(selected.workspaceId, [locator])
  const savedRevision = await revision(selected.workspaceId)
  expect(await read(selected.workspaceId)).toEqual([locator])
  expect(savedRevision).toEqual(expect.any(String))

  activePerson = crypto.randomUUID()
  await expect(read(selected.workspaceId)).rejects.toThrow("Identity changed")
  await expect(merge(selected.workspaceId, [{ ...locator, transferId: "transfer-two" }])).rejects.toThrow("Identity changed")
  activePerson = owner
  expect(await read(selected.workspaceId)).toEqual([locator])
  expect(await revision(selected.workspaceId)).toBe(savedRevision)
})
