import { expect, test } from "vitest"
import type { BlindReplicaConfig, IdentityReplicaConfig } from "./blindReplication"
import { replicaKey, replicaStatus, replicationPresence, type ReplicaHealth } from "./replicationHealth"
import { profileDeliveryStates } from "./profileDeliveryHealth"
const board = { origin: "https://rusty.example", scopeId: "one", workspaceId: "board" } as BlindReplicaConfig
const other = { ...board, scopeId: "two", workspaceId: "other" }
const now = 100_000
const healthy: ReplicaHealth = { phase: "synced", lastSyncedAt: now - 1000 }

test("Given offline devices and a confirmed Rusty pass, then board status is connected", () => {
 expect(replicationPresence("offline", [board], { [replicaKey(board)]: healthy }, "board", now)).toBe("connected")
 expect(replicaStatus(board, healthy, now)).toBe("Synced")
})
test("Given saved Rusty settings, when no pass was confirmed, then no connected claim is shown", () => {
 expect(replicaStatus(board, undefined, now)).toBe("Not checked")
 expect(replicationPresence("offline", [board], {}, "board", now)).toBe("reconnecting")
})
test("Given a recent board confirmation, when an ordinary poll runs, then presence stays connected without hiding pending, failed or overdue sync", () => {
 const polling: ReplicaHealth = { ...healthy, phase: "syncing" }
 expect(replicaStatus(board, polling, now)).toBe("Syncing")
 expect(replicationPresence("offline", [board], { [replicaKey(board)]: polling }, "board", now)).toBe("connected")
 expect(replicationPresence("offline", [board], { [replicaKey(board)]: polling }, "board", now + 60_000)).toBe("reconnecting")
 for (const phase of ["paused", "error", "catching-up"] as const) {
  expect(replicationPresence("offline", [board], { [replicaKey(board)]: { ...healthy, phase } }, "board", now)).not.toBe("connected")
 }
})
test("Given two boards, when only the other board fails, then active board retains its confirmed status", () => {
 const states = { [replicaKey(board)]: healthy, [replicaKey(other)]: { phase: "error", error: "Server unavailable" } as ReplicaHealth }
 expect(replicationPresence("offline", [board, other], states, "board", now)).toBe("connected")
 expect(replicationPresence("empty", [board, other], states, "other", now)).toBe("offline")
 expect(replicationPresence("empty", [board, other], states, "unconfigured", now)).toBe("empty")
 expect(replicationPresence("connected", [board, other], states, "other", now)).toBe("connected")
})
test("Given a prior successful sync, when a request fails or confirmation expires, then status stops claiming healthy", () => {
 expect(replicaStatus(board, { ...healthy, phase: "error", error: "Offline" }, now)).toBe("Unavailable")
 expect(replicaStatus(board, healthy, now + 60_000)).toBe("Check overdue")
 expect(replicationPresence("empty", [board], { [replicaKey(board)]: healthy }, "board", now + 60_000)).toBe("offline")
 expect(replicaStatus({ ...board, removalPending: true }, healthy, now)).toBe("Removal pending")
 expect(replicationPresence("offline", [{ ...board, removalPending: true }], { [replicaKey(board)]: healthy }, "board", now)).toBe("offline")
 expect(replicaStatus(board, { ...healthy, phase: "syncing" }, now)).toBe("Syncing")
 expect(replicaStatus(board, { ...healthy, phase: "catching-up" }, now)).toBe("Catching up")
 expect(replicationPresence("offline", [board], { [replicaKey(board)]: { ...healthy, phase: "catching-up" } }, "board", now)).toBe("reconnecting")
})

const personal = { origin: board.origin, scopeId: "person-scope", personId: "person-1", purpose: "identity" } as IdentityReplicaConfig

test("Given a synced board and no personal Rusty scope, when profile delivery is shown, then it stays unconfigured", () => {
 const rows = profileDeliveryStates([board], [], { [replicaKey(board)]: healthy }, "board", now)
 expect(rows).toEqual([{ key: board.origin, origin: board.origin, status: "Profile delivery not configured" }])
})

test("Given board and profile scopes on one Rusty origin, when only board has a successful pass, then profile is not called synced", () => {
 const rows = profileDeliveryStates([board], [personal], { [replicaKey(board)]: healthy }, "board", now)
 expect(rows).toHaveLength(1)
 expect(rows[0].status).toBe("Not checked")
})

test("Given a personal scope, when its pass fails or expires, then profile delivery reports that independent state", () => {
 expect(profileDeliveryStates([board], [personal], { [replicaKey(personal)]: { phase: "error", error: "offline" } }, "board", now)[0])
   .toMatchObject({ status: "Unavailable", error: "offline" })
 expect(profileDeliveryStates([board], [personal], { [replicaKey(personal)]: healthy }, "board", now + 60_000)[0].status)
   .toBe("Check overdue")
 expect(profileDeliveryStates([board], [{ ...personal, removalPending: true }], { [replicaKey(personal)]: healthy }, "board", now)[0].status)
   .toBe("Removal pending")
})
