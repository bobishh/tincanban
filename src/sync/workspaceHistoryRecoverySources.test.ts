import { describe, expect, it } from "vitest"
import { receivedHistoryHasRustyArchiveRoute } from "./workspaceHistoryRecoverySources"

describe("received encrypted history source routing", () => {
  it("keeps an exact Rusty wire route when the same baseline also carries peer proofs", () => {
    const row = { peerProofs: { version: 1 as const, objects: [] }, wire: { signedJson: "signed-baseline" } }
    expect(receivedHistoryHasRustyArchiveRoute(row)).toBe(true)
  })

  it("keeps peer-only baselines on the peer route and Rusty-only rows on Rusty", () => {
    expect(receivedHistoryHasRustyArchiveRoute({ peerProofs: { version: 1, objects: [] } })).toBe(false)
    expect(receivedHistoryHasRustyArchiveRoute({ wire: { signedJson: "signed-baseline" } })).toBe(true)
  })
})
