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
