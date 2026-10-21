import { expect, it } from "vitest"
import { parseRustyStatusRequest, createRustyStatusReply, assertRustyStatusRequest } from "./rustyStatusHandoff"

const now = 1_000_000
const request = { origin: "https://rusty.example", requestId: "a".repeat(32), expiresAt: now + 120_000 }
const hash = (value: unknown) => `#rusty-status=${encodeURIComponent(JSON.stringify(value))}`

it("Given a bounded Rusty status request, when opening its confirmation, then retain only validated origin, nonce and deadline", () => {
  expect(parseRustyStatusRequest(hash({ ...request, readToken: "never copy" }), now)).toEqual(request)
  expect(parseRustyStatusRequest("#message-unrelated", now)).toBeUndefined()
  for (const origin of ["javascript:alert(1)", "http://remote.example", "https://rusty.example/path", "https://user@rusty.example"]) {
    expect(() => parseRustyStatusRequest(hash({ ...request, origin }), now)).toThrow()
  }
  expect(() => parseRustyStatusRequest(hash({ ...request, expiresAt: now }), now)).toThrow(/expired/i)
})

it("Given several private board connections, when sharing status, then reveal only explicit fields for the exact requested server", () => {
  const configs = [
    { origin: request.origin, workspaceId: "board-one", scopeId: "scope-one", readToken: "secret read", writeToken: "secret write", contentKey: "secret key" },
    { origin: "https://other.example", workspaceId: "board-two", scopeId: "scope-two" },
  ]
  const reply = createRustyStatusReply(request, configs as never, [{ id: "board-one", title: "Private board" }, { id: "board-two", title: "Other board" }],
    { [`${request.origin}/scope-one`]: { phase: "synced", lastSyncedAt: now - 1000, error: "never copy" } }, now)
  expect(reply).toEqual({ type: "rusty-status@1", requestId: request.requestId, origin: request.origin, checkedAt: now,
    boards: [{ id: "board-one", title: "Private board", status: "Synced", access: "read-write", lastSyncedAt: now - 1000 }] })
  expect(JSON.stringify(reply)).not.toMatch(/secret|scope-one|Other board|never copy/)
})

it("Given an approval is pending, when its deadline, opener or request changes, then send nothing", () => {
  const opener = {} as Window
  expect(() => assertRustyStatusRequest(request, request, opener, opener, now)).not.toThrow()
  expect(() => assertRustyStatusRequest(request, request, opener, null, now)).toThrow(/changed/i)
  expect(() => assertRustyStatusRequest({ ...request, requestId: "b".repeat(32) }, request, opener, opener, now)).toThrow(/changed/i)
  expect(() => assertRustyStatusRequest(request, request, opener, opener, request.expiresAt)).toThrow(/expired/i)
})

it("Given conflicting saved credentials have no active connection, when inspecting that board, then report paused access instead of omitting it", () => {
  const reply = createRustyStatusReply(request, [], [{ id: "board-one", title: "Paused board" }], {}, now,
    [{ origin: request.origin, workspaceIds: ["board-one"] }] as never)
  expect(reply.boards).toEqual([{ id: "board-one", title: "Paused board", status: "Sync paused", access: "not-confirmed" }])
})
