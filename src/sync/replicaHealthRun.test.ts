import { ref } from "vue"
import { expect, test } from "vitest"
import { RustyResponseError } from "@meta-uber/mesh-replication/rusty-replica"
import { recordReplicaHealth } from "./replicaHealthRun"
import { replicaKey, replicaStatus, type ReplicaHealth } from "./replicationHealth"
import type { BlindReplicaConfig } from "./blindReplication"

const config = { origin: "https://rusty.example", scopeId: "scope", workspaceId: "board" } as BlindReplicaConfig

test("Given legacy participant access, when owner reissue is pending, then stop claiming storage sync and resume after fresh access arrives", async () => {
  const { ParticipantStorageAccessPendingError } = await import("./replicationErrors")
  const statuses = ref<Record<string, ReplicaHealth>>({ [replicaKey(config)]: { phase: "synced", lastSyncedAt: Date.now() } })
  const issues = ref<Record<string, string>>({ [replicaKey(config)]: "Old retry error" })
  await recordReplicaHealth(config, statuses, async () => { throw new ParticipantStorageAccessPendingError() }, () => true, issues)
  expect(statuses.value[replicaKey(config)]).toEqual({ phase: "access-pending" })
  expect(replicaStatus(config, statuses.value[replicaKey(config)], Date.now())).toBe("Waiting for access")
  expect(issues.value).toEqual({})
  await recordReplicaHealth(config, statuses, async () => true, () => true, issues)
  expect(replicaStatus(config, statuses.value[replicaKey(config)], Date.now())).toBe("Synced")
})

test("Given a local persistence error, when sync stops, then report a device problem without blaming Rusty or exposing its exception", async () => {
  const statuses = ref<Record<string, ReplicaHealth>>({})
  const issues = ref<Record<string, string>>({})
  const message = await recordReplicaHealth(config, statuses, async () => {
    throw new Error("Replica progress generation changed during persistence")
  }, () => true, issues)
  expect(message).toBeUndefined()
  expect(replicaStatus(config, statuses.value[replicaKey(config)], Date.now())).toBe("Sync paused")
  expect(statuses.value[replicaKey(config)]?.error).toBeUndefined()
  expect(issues.value[replicaKey(config)]).toBe("Board sync paused on this device. Your saved changes are retained. Retry sync.")
})

test("Given an actual transport failure, when sync stops, then show a safe server error without exposing raw transport details", async () => {
  const { rustyRequestFailure } = await import("./replicationErrors")
  const statuses = ref<Record<string, ReplicaHealth>>({})
  const issues = ref<Record<string, string>>({})
  await recordReplicaHealth(config, statuses, async () => { throw rustyRequestFailure(new Error("raw-private-detail")) }, () => true, issues)
  expect(statuses.value[replicaKey(config)]).toMatchObject({ phase: "error", error: "Rusty connection unavailable. Retry sync." })
  expect(issues.value).toEqual({})
})

test("Given an SDK response parsing failure, when sync reports it, then classify only the HTTP failure as Rusty-originated", async () => {
  const { isRustyRequestFailure } = await import("./replicationErrors")
  const responseFailure = new RustyResponseError("Rusty returned HTTP 503", { status: 503 })
  expect(isRustyRequestFailure(responseFailure)).toBe(true)
  expect(isRustyRequestFailure(new Error("Rusty receipt signature invalid"))).toBe(false)

  const statuses = ref<Record<string, ReplicaHealth>>({})
  const issues = ref<Record<string, string>>({})
  await recordReplicaHealth(config, statuses, async () => { throw responseFailure }, () => true, issues)
  expect(statuses.value[replicaKey(config)]).toMatchObject({ phase: "error", error: "Rusty connection unavailable. Retry sync." })
  expect(issues.value).toEqual({})
})

test("Given a competing writer commits first, when the sync operation rereads durable progress, then retry safely and clear the device issue", async () => {
  const { ReplicaProgressConflictError } = await import("./replicationErrors")
  const statuses = ref<Record<string, ReplicaHealth>>({})
  const issues = ref<Record<string, string>>({ [replicaKey(config)]: "old problem" })
  let attempts = 0
  await recordReplicaHealth(config, statuses, async () => {
    if (++attempts === 1) throw new ReplicaProgressConflictError()
    return true
  }, () => true, issues)
  expect(attempts).toBe(2)
  expect(statuses.value[replicaKey(config)]?.phase).toBe("synced")
  expect(issues.value).toEqual({})
})

test("Given contention continues, when sync retries its durable state, then bound retries and retain a device issue without claiming Rusty unavailable", async () => {
  const { ReplicaProgressConflictError } = await import("./replicationErrors")
  const statuses = ref<Record<string, ReplicaHealth>>({})
  const issues = ref<Record<string, string>>({})
  let attempts = 0
  await recordReplicaHealth(config, statuses, async () => { attempts++; throw new ReplicaProgressConflictError() }, () => true, issues)
  expect(attempts).toBe(3)
  expect(statuses.value[replicaKey(config)]?.phase).toBe("paused")
  expect(issues.value[replicaKey(config)]).toContain("on this device")
})

test("Given Rusty denies access, when sync reports the HTTP response, then request access without declaring the server unavailable", async () => {
  const { rustyRequestFailure } = await import("./replicationErrors")
  const statuses = ref<Record<string, ReplicaHealth>>({})
  await recordReplicaHealth(config, statuses, async () => { throw rustyRequestFailure(new Error("private-access-detail"), 403) }, () => true)
  expect(replicaStatus(config, statuses.value[replicaKey(config)], Date.now())).toBe("Access required")
  expect(statuses.value[replicaKey(config)]?.error).toBe("Rusty access needs attention. Check device access.")
})
