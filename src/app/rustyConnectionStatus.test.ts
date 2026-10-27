import { expect, it } from "vitest"
import { rustyConnectionStates } from "./rustyConnectionStatus"

const board = { origin: "https://rusty.example", scopeId: "board", workspaceId: "workspace" }
const identity = { origin: board.origin, scopeId: "identity" }
const now = Date.now()
const confirmed = { phase: "synced" as const, lastSyncedAt: now }

it("Given board and Identity delivery share a Rusty, when displaying connections, then show one confirmed server", () => {
  expect(rustyConnectionStates([board], [identity], {
    [`${board.origin}/board`]: confirmed, [`${board.origin}/identity`]: confirmed,
  }, "workspace", true, now)).toMatchObject([{ origin: board.origin, status: "Synced", lastSyncedAt: now }])
})

it("Given a board is saved but delivery is failing, when displaying its server, then do not claim synchronized", () => {
  expect(rustyConnectionStates([board], [identity], {
    [`${board.origin}/board`]: confirmed,
    [`${board.origin}/identity`]: { phase: "error", error: "Server unavailable", errorKind: "unavailable" },
  }, "workspace", true, now)).toMatchObject([{ status: "Unavailable", errors: ["Server unavailable"] }])
})

it("Given a participant's shared board, when their own Identity has no Rusty, then shared delivery still confirms", () => {
  expect(rustyConnectionStates([{ ...board, boardAccess: {} }], [], {
    [`${board.origin}/board`]: confirmed,
  }, "workspace", false, now)).toMatchObject([{ status: "Synced" }])
})

it("Given a saved owner server without this board, when opening Sync, then show it once without claiming a board copy", () => {
  expect(rustyConnectionStates([], [identity], {
    [`${board.origin}/identity`]: confirmed,
  }, "workspace", true, now)).toMatchObject([{ origin: board.origin, status: "Not connected" }])
  expect(rustyConnectionStates([], [identity], {}, "foreign", false, now)).toEqual([])
})
