import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { recordUsageAction } from "./usageAnalytics"
const config = vi.hoisted(() => ({ enabled: true, endpoint: "https://sink.invalid", analyticsEndpoint: "https://sink.invalid/events", project: "tincanban", browserKey: "public-fixture", sampleRate: 1 }))
vi.mock("./sync/telemetryConfig", () => ({ telemetryConfig: () => config }))
beforeEach(() => { config.enabled = true; vi.stubGlobal("fetch", vi.fn(async () => new Response('{}', { status: 200 }))) })
afterEach(() => vi.unstubAllGlobals())
it("Given successful board actions, when counted, then only fixed event names and a fixed app surface leave the browser", () => {
  for (const event of ["item_open", "item_create", "item_move", "chat_send", "workspace_create"] as const) recordUsageAction(event)
  const payloads = vi.mocked(fetch).mock.calls.map(([, options]) => JSON.parse(String(options?.body)))
  expect(payloads.flatMap(payload => payload.events.map((event: { event: string }) => event.event))).toEqual(["item_open", "item_create", "item_move", "chat_send", "workspace_create"])
  expect(payloads.every(payload => payload.schema_version === 1 && payload.events[0].path === "/app")).toBe(true)
  expect(JSON.stringify(payloads)).not.toMatch(/workspace_id|device_id|person_id|title|body/)
})
it("Given device collection is disabled or the intake fails, when an action succeeds, then collection stays optional", async () => {
  config.enabled = false
  recordUsageAction("item_create")
  expect(fetch).not.toHaveBeenCalled()
  config.enabled = true
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unavailable") }))
  expect(() => recordUsageAction("item_create")).not.toThrow()
  await Promise.resolve()
})
