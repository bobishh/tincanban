import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { recordUsageAction, startUsageAnalytics } from "./usageAnalytics"
const config = vi.hoisted(() => ({ enabled: true }))
vi.mock("./sync/telemetryConfig", () => ({ telemetryConsent: () => config.enabled }))
let events: unknown[]
beforeEach(() => {
  events = []
  config.enabled = true
  const target = new EventTarget()
  target.addEventListener("application:action", event => events.push((event as CustomEvent).detail))
  target.addEventListener("application:surface", event => events.push((event as CustomEvent).detail))
  vi.stubGlobal("window", target)
  vi.stubGlobal("fetch", vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

it("Given no installed external producer, when app events occur, then emit only local intent and make no network request", () => {
  startUsageAnalytics("/app")
  recordUsageAction("item_create")
  expect(events).toEqual([{ path: "/app" }, { event: "item_create" }])
  expect(fetch).not.toHaveBeenCalled()
})
it("Given device diagnostics are disabled, when an app action succeeds, then emit nothing", () => {
  config.enabled = false
  startUsageAnalytics("/boards")
  recordUsageAction("item_create")
  expect(events).toEqual([])
  expect(fetch).not.toHaveBeenCalled()
})
