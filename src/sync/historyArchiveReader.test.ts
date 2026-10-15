import { expect, it, vi } from "vitest"
import { createHistoryArchiveReader } from "./historyArchiveReader"

it("Given a host-crafted baseline flag, when opening archived item history, then refuse before any storage or network read", () => {
  const download = vi.fn()
  expect(() => createHistoryArchiveReader({ basis: { verified: true } as never,
    scope: { scopeId: "scope", keyEpoch: 1, key: new Uint8Array(32) },
    fetch: { download, ensureCurrent: () => {} }, ensureCurrent: () => {} })).toThrow(/Native|verified/i)
  expect(download).not.toHaveBeenCalled()
})
it("Given a cancelled history session, when constructing its reader, then reject before inspecting the signed source", () => {
  expect(() => createHistoryArchiveReader({ basis: undefined as never,
    scope: { scopeId: "scope", keyEpoch: 1, key: new Uint8Array(32) },
    fetch: { download: vi.fn(), ensureCurrent: () => {} }, ensureCurrent: () => { throw new Error("History selection changed") } }))
    .toThrow("History selection changed")
})
