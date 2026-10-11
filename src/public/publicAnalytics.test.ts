import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ enabled: true, level: "all" as "all" | "errors", sampleRate: 1 }))

vi.mock("../sync/telemetryConfig", () => ({ telemetryConfig: () => ({ enabled: mocks.enabled, endpoint: "https://collector.example/ingest", project: "tincanban", browserKey: "browser-key-123456", level: mocks.level, sampleRate: mocks.sampleRate }) }))

describe("public board analytics", () => {
  beforeEach(() => { vi.resetModules(); mocks.enabled = true; mocks.level = "all"; mocks.sampleRate = 1; vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 202 }))) })

  it("sends one content-free view event with empty private identities", async () => {
    const { recordPublicBoardView } = await import("./publicAnalytics")
    recordPublicBoardView("public-board")
    recordPublicBoardView("public-board")
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    const [, request] = vi.mocked(fetch).mock.calls[0]!
    const payload = JSON.parse(String(request?.body)) as { events: Array<Record<string, unknown>> }
    expect(payload.events).toHaveLength(1)
    expect(payload.events[0]).toMatchObject({ event: "public.board.viewed", device_id: "", workspace_id: "", entity_type: "board", entity_id: "public-board" })
    expect(JSON.stringify(payload)).not.toMatch(/title|body|field|value|credential|private/)
  })

  it("sends nothing when diagnostics are opted out", async () => {
    mocks.enabled = false
    const { recordPublicBoardView } = await import("./publicAnalytics")
    recordPublicBoardView("public-board")
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("sends nothing for errors-only diagnostics or a zero sample rate", async () => {
    const { recordPublicBoardView } = await import("./publicAnalytics")
    mocks.level = "errors"
    recordPublicBoardView("public-board")
    mocks.level = "all"
    mocks.sampleRate = 0
    recordPublicBoardView("public-board")
    await Promise.resolve()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("does not redraw a sampled-out view after an unavailable page retries", async () => {
    mocks.sampleRate = 0.5
    const random = vi.spyOn(Math, "random").mockReturnValue(0.75)
    const { recordPublicBoardView } = await import("./publicAnalytics")
    recordPublicBoardView("public-board")
    random.mockReturnValue(0.25)
    recordPublicBoardView("public-board")
    await Promise.resolve()
    expect(random).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("does not block public rendering when the intake is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("collector unavailable") }))
    const { recordPublicBoardView } = await import("./publicAnalytics")
    expect(() => recordPublicBoardView("public-board")).not.toThrow()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  })
})
