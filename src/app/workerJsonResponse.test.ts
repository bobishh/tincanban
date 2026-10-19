import { afterEach, expect, it, vi } from "vitest"
import { requestWorkerJson } from "./workerJsonResponse"

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it("Given a gateway returns plain text, when owner management waits for its response, then show the HTTP failure and retain retry intent", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("error code: 502", { status: 502 })))
  await expect(requestWorkerJson("https://automation.example", "/v2/automation-instances/identity", "POST", 1024, {}))
    .rejects.toThrow("Automation service is unavailable (HTTP 502). Retry the same operation.")
})

it("Given a signed mutation, when Reflux processes it, then allow its bounded request to complete before the client expires", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout")
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ confirmed: true })))
  await expect(requestWorkerJson("https://automation.example", "/v2/integrations/id/activation", "PUT", 1024, {}))
    .resolves.toEqual({ confirmed: true })
  expect(timeout).toHaveBeenCalledWith(60_000)
})

it("Given response headers arrive while the body waits, when management is pending, then trace headers and body separately without exporting request content", async () => {
  const telemetry = await import("../sync/telemetry")
  const observed = vi.spyOn(telemetry, "record")
  let close!: () => void
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"confirmed":true}'))
    close = () => controller.close()
  } }))
  const fetcher = vi.fn<typeof fetch>(async () => response)
  vi.stubGlobal("fetch", fetcher)
  const pending = requestWorkerJson("https://automation.example", "/v2/automation-instances/identity", "POST", 1024,
    { privatePayload: "never-export-this" })
  try {
    await vi.waitFor(() => expect(observed.mock.calls.some(([name]) => name === "automation.management.identity.fetchHeaders.completed")).toBe(true))
    expect(observed.mock.calls.some(([name]) => name === "automation.management.identity.readBody.completed")).toBe(false)
  } finally { close(); await pending }
  expect(observed.mock.calls.some(([name]) => name === "automation.management.identity.parseJson.completed")).toBe(true)
  expect(JSON.stringify(observed.mock.calls)).not.toContain("never-export-this")
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ mode: "cors", credentials: "omit", headers: { "content-type": "application/json" } })
})
