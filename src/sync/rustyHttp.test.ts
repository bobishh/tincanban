import { afterEach, describe, expect, it, vi } from "vitest"
import { ROOT_CONTEXT } from "@opentelemetry/api"
import { setHttpDiagnosticSpanFactory } from "../domain/httpDiagnostics"
import { fetchBlind } from "./rustyHttp"

afterEach(() => { vi.unstubAllGlobals(); setHttpDiagnosticSpanFactory(undefined) })

describe("Rusty HTTP diagnostics", () => {
  it("Given a request context, When Rusty responds, Then propagate its trace and record status without URL secrets", async () => {
    const end = vi.fn(), factory = vi.fn(() => ({ headers: { traceparent: "00-parent-span-01" }, end }))
    const request = vi.fn(async () => new Response("ok", { status: 200 }))
    setHttpDiagnosticSpanFactory(factory)
    vi.stubGlobal("fetch", request)
    await fetchBlind("https://rusty.test/v1/replicas/secret-scope?token=secret", { method: "POST", diagnosticContext: ROOT_CONTEXT })
    expect(factory).toHaveBeenCalledWith("HTTP POST", { "http.request.method": "POST", "server.address": "rusty.test" }, ROOT_CONTEXT)
    const sent = request.mock.calls[0] as unknown as [string, RequestInit & { diagnosticContext?: unknown }]
    expect(new Headers(sent[1].headers).get("traceparent")).toBe("00-parent-span-01")
    expect(sent[1]).not.toHaveProperty("diagnosticContext")
    expect(end).toHaveBeenCalledWith(undefined, 200)
  })

  it("Given a failed request, When diagnostic completion also fails, Then preserve the original transport exception", async () => {
    const failure = new TypeError("network unavailable")
    const end = vi.fn(() => { throw new Error("diagnostic unavailable") })
    setHttpDiagnosticSpanFactory(() => ({ headers: {}, end }))
    vi.stubGlobal("fetch", vi.fn(async () => { throw failure }))
    await expect(fetchBlind("https://rusty.test/v1/replicas", {})).rejects.toBe(failure)
    expect(end).toHaveBeenCalledWith(failure, undefined)
  })
})
