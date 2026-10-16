import { describe, expect, it } from "vitest"
import { historyActionLabel, historyAuthorLabel } from "./historyPresentation"
import type { HistoryEntry } from "../domain/history"

const entry = (overrides: Partial<HistoryEntry> = {}): HistoryEntry => ({
  hash: "change-hash", time: 1, actor: "actor-id", action: "createItem",
  entityIds: ["item-id"], authorLabel: "Unverified author", isLegacy: false,
  personId: "person-id", deviceId: "device-id", ...overrides,
})

describe("history presentation", () => {
  it("uses only a supplied verified name and preserves meaningful attribution states", () => {
    expect(historyAuthorLabel(entry(), "Alice Example")).toBe("Alice Example")
    expect(historyAuthorLabel(entry())).toBe("Unverified author")
    expect(historyAuthorLabel(entry({ personId: undefined, deviceId: undefined }))).toBe("System change")
    expect(historyAuthorLabel(entry({ isLegacy: true, personId: undefined, deviceId: undefined }))).toBe("Imported")
    expect(historyAuthorLabel(entry({ archive: { sourceId: "source", baselineId: "baseline", historyEpoch: 1, observation: "admitted" } }), "Alice Example"))
      .toBe("Archived author claim")
  })

  it("humanizes known operation keys while retaining unknown keys readably", () => {
    expect(historyActionLabel("createItem")).toBe("Create item")
    expect(historyActionLabel("restoreItemVersion")).toBe("Restore item version")
    expect(historyActionLabel("customAction-v2")).toBe("Custom action v2")
  })
})
