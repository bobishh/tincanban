import { describe, expect, it } from "vitest"
import { selectActiveHistoryRoute } from "./workspaceActiveHistoryRoute"

const signed = (text: string) => new TextEncoder().encode(text)
function route(baselineId: string, historyEpoch: number, signedJson = signed(baselineId)) {
  return { baselineId, historyEpoch, signedJson, route: { baselineId } }
}

describe("active archived history routing", () => {
  it("Given a retained checkpoint-conflict candidate, When recapture activates its sibling, Then history starts from the exact active basis", () => {
    const abandoned = route("abandoned", 2), accepted = route("accepted", 2), parent = route("parent", 1)
    const retained = [abandoned, parent, accepted]
    expect(selectActiveHistoryRoute(retained, accepted)).toBe(accepted.route)
    expect(retained).toEqual([abandoned, parent, accepted])
  })

  it("Given a newer staged candidate, When reading the current board, Then it cannot replace the active basis", () => {
    const active = route("active", 1)
    expect(selectActiveHistoryRoute([active, route("staged", 2)], active)).toBe(active.route)
  })

  it("Given retained archives without an active compact basis, Then none becomes active by epoch ordering", () => {
    expect(selectActiveHistoryRoute([route("abandoned", 1)], undefined)).toBeUndefined()
  })

  it("Given an active basis without a reading route, Then reading refuses an unrelated retained basis", () => {
    expect(() => selectActiveHistoryRoute([route("other", 1)], route("missing", 1))).toThrow(/active.*unavailable/i)
  })

  it("Given a copied baseline ID with different signed bytes, Then reading refuses the mismatched descriptor", () => {
    const active = route("active", 1)
    expect(() => selectActiveHistoryRoute([route("active", 1, signed("different"))], active)).toThrow(/signed descriptor/i)
  })

  it("Given encrypted and peer routes for one exact active descriptor, Then either transport can serve the same basis", () => {
    const active = route("active", 1), peer = route("active", 1)
    expect(selectActiveHistoryRoute([active, peer], active)).toBe(active.route)
  })
})
