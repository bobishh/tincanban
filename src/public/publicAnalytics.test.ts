import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ enabled: true }))
vi.mock("../sync/telemetryConfig", () => ({ telemetryConsent: () => mocks.enabled }))

let surfaces: unknown[]
beforeEach(() => {
  vi.resetModules()
  mocks.enabled = true
  surfaces = []
  const target = new EventTarget()
  target.addEventListener("application:surface", event => surfaces.push((event as CustomEvent).detail))
  vi.stubGlobal("window", target)
  vi.stubGlobal("fetch", vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe("public board local intent", () => {
  it("Given no deployment producer, when a public board renders twice, then emit one local surface without its identity or network traffic", async () => {
    const { recordPublicBoardView } = await import("./publicAnalytics")
    recordPublicBoardView("public-board")
    recordPublicBoardView("public-board")
    expect(surfaces).toEqual([{ path: "/boards" }])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("Given diagnostics are opted out, when a public board renders, then emit nothing", async () => {
    mocks.enabled = false
    const { recordPublicBoardView } = await import("./publicAnalytics")
    recordPublicBoardView("public-board")
    expect(surfaces).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("Given an invalid board identity, when rendering retries with a valid board, then only the valid view emits local intent", async () => {
    const { recordPublicBoardView } = await import("./publicAnalytics")
    recordPublicBoardView("invalid/board")
    expect(surfaces).toEqual([])
    recordPublicBoardView("public-board")
    expect(surfaces).toEqual([{ path: "/boards" }])
    expect(fetch).not.toHaveBeenCalled()
  })
})
