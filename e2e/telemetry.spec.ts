import { expect, test, type Page } from "./support/coverage"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

type Attribute = { key: string; value: Record<string, unknown> }
type LogRecord = { body?: Record<string, unknown>; attributes?: Attribute[]; traceId?: string; spanId?: string }
type OtlpLogs = { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: LogRecord[] }> }> }
type Span = { name?: string; traceId?: string; spanId?: string; parentSpanId?: string; attributes?: Attribute[] }
type OtlpTraces = { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Span[] }> }> }
const endpoint = "https://telemetry.invalid/v1/logs"
const tracesEndpoint = "https://telemetry.invalid/v1/traces"
const browserKey = "public-browser-fixture-key-0123456789"

test("Given a real no-store intake, when repeated error batches cross the keepalive budget and a batch is rejected, then later diagnostics still arrive", async ({ page, baseURL }) => {
  const received: LogRecord[] = []
  const requestBytes: number[] = []
  const server = createServer((request, response) => {
    const headers = { "Access-Control-Allow-Origin": baseURL!, "Access-Control-Allow-Headers": "authorization,content-type,x-tinsink-project,x-tinsink-source",
      "Access-Control-Allow-Methods": "POST,OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" }
    if (request.method === "OPTIONS") { response.writeHead(204, headers); response.end(); return }
    const chunks: Buffer[] = []
    request.on("data", chunk => chunks.push(Buffer.from(chunk)))
    request.on("end", () => {
      const data = Buffer.concat(chunks)
      requestBytes.push(data.byteLength)
      const records = logRecords(JSON.parse(data.toString("utf8")) as OtlpLogs)
      const rejected = records.some(record => body(record) === "diagnostic.intake.reject")
      if (!rejected && data.byteLength <= 65_536) received.push(...records)
      response.writeHead(data.byteLength > 65_536 ? 413 : rejected ? 400 : 200, headers)
      response.end('{"partialSuccess":{}}')
    })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  try {
    await interceptOtlp(page, 200)
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled()
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const result = await page.evaluate(async ({ origin, browserKey }) => {
      const { BrowserOtelSdk } = await import("/src/sync/otelBrowserSdk.ts")
      let onIdle: (() => void) | undefined
      const sdk = new BrowserOtelSdk({ enabled: true, endpoint: origin, logsEndpoint: `${origin}/v1/logs`, tracesEndpoint: `${origin}/v1/traces`,
        project: "tincanban", browserKey, level: "all", sampleRate: 1 }, () => {
        if (sdk.exportState.sending === 0 && sdk.exportState.queued === 0) onIdle?.()
      })
      // The processor's best-effort flush can time out before every split body
      // finishes. Observe actual delivery before introducing the next outcome.
      const flush = async () => {
        const idle = new Promise<void>(resolve => { onIdle = resolve })
        await sdk.forceFlush()
        if (sdk.exportState.sending || sdk.exportState.queued) await idle
        onIdle = undefined
        return { ...sdk.exportState }
      }
      const wave = async (name: string) => {
        for (let index = 0; index < 50; index++) {
          const error = new Error("Synthetic keepalive failure")
          error.stack = `Error: synthetic failure\n${"at syntheticFrame (fixture.ts:1:1)\n".repeat(500)}`
          sdk.emit({ event: "diagnostic.keepalive.failed", detail: { entityId: `${name}-${index}` }, exception: error, level: "error", timestamp: Date.now() })
        }
        return flush()
      }
      try {
        const first = await wave("first")
        sdk.emit({ event: "diagnostic.intake.reject", detail: {}, level: "warn", timestamp: Date.now() })
        const rejected = await flush()
        const recovered = await wave("recovered")
        return { first, rejected, recovered }
      } finally { await sdk.shutdown() }
    }, { origin, browserKey })
    expect(result.first.dropped).toBe(0)
    expect(result.rejected.error).toContain("HTTP 400")
    expect(result.recovered.dropped).toBe(1)
    expect(result.recovered.error).toBe("")
    expect(received).toHaveLength(100)
    expect(new Set(received.map(record => attribute(record, "entity.id"))).size).toBe(100)
    expect(Math.max(...requestBytes)).toBeLessThanOrEqual(65_536)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test("Given a burst of long sync failures, when diagnostics flush through a 64 KiB intake, then every failure arrives and chat remains usable", async ({ page }) => {
  const received: LogRecord[] = []
  const requestBytes: number[] = []
  await page.route(endpoint, async route => {
    const bytes = route.request().postDataBuffer()!.byteLength
    requestBytes.push(bytes)
    if (bytes > 65_536) return route.fulfill({ status: 413, body: "Request body exceeds the 65536-byte limit" })
    received.push(...logRecords(route.request().postDataJSON() as OtlpLogs))
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  })
  await page.route(tracesEndpoint, route => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }))
  await page.route("https://telemetry.invalid/events", route => route.fulfill({ status: 200, contentType: "application/json", body: '{"accepted":1}' }))
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled()
  await expect.poll(() => received.length).toBeGreaterThan(0)
  await page.evaluate(async () => {
    const { record, retryTelemetry } = await import("/src/sync/telemetry.ts")
    for (let index = 0; index < 50; index++) {
      const error = new Error(`Connection failed ${index}`)
      error.stack = `Error: Connection failed ${index}\n${"at syntheticFrame (transport.ts:1:1)\n".repeat(470)}`
      record("sync.burst.failed", { error, entityId: `failure-${index}` }, "error")
    }
    retryTelemetry()
  })
  await expect.poll(() => received.filter(item => body(item) === "sync.burst.failed").length, { timeout: 15_000 }).toBe(50)
  expect(Math.max(...requestBytes)).toBeLessThanOrEqual(65_536)
  expect(new Set(received.filter(item => body(item) === "sync.burst.failed").map(item => attribute(item, "entity.id"))).size).toBe(50)
  await send(page, "chat-survives-error-burst")
  await page.reload()
  const chat = await send(page, "after-error-burst-reload")
  await expect(chat.getByText("chat-survives-error-burst", { exact: true })).toBeVisible()
})

function logRecords(payload: OtlpLogs): LogRecord[] {
  return (payload.resourceLogs ?? []).flatMap(resource => (resource.scopeLogs ?? []).flatMap(scope => scope.logRecords ?? []))
}
function body(record: LogRecord): string | undefined { return record.body?.stringValue as string | undefined }
function attribute(record: LogRecord, key: string): unknown {
  const value = record.attributes?.find(item => item.key === key)?.value
  return value && Object.values(value)[0]
}
function spans(payload: OtlpTraces): Span[] {
  return (payload.resourceSpans ?? []).flatMap(resource => (resource.scopeSpans ?? []).flatMap(scope => scope.spans ?? []))
}
async function settings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
  await dialog.getByRole("tab", { name: "Workspace", exact: true }).click()
  await expect(dialog.getByRole("checkbox", { name: "Send diagnostics from this device" })).toHaveCount(0)
  await expect(dialog.getByLabel("Intake URL")).toHaveCount(0)
  return dialog
}
async function send(page: Page, text: string) {
  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill(text)
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.getByText(text, { exact: true })).toBeVisible()
  await expect(chat.getByText("Saving locally…", { exact: true })).toHaveCount(0)
  return chat
}
async function interceptOtlp(page: Page, status: number, records: LogRecord[] = [], exportedSpans: Span[] = []) {
  const requests: string[] = []
  for (const url of [endpoint, tracesEndpoint]) await page.route(url, async route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${browserKey}`)
    expect(route.request().headers()["x-tinsink-project"]).toBe("tincanban")
    expect(route.request().headers()["x-tinsink-source"]).toBe("browser")
    requests.push(url)
    const payload = route.request().postDataJSON() as OtlpLogs | OtlpTraces
    if (url === endpoint) records.push(...logRecords(payload as OtlpLogs))
    else exportedSpans.push(...spans(payload as OtlpTraces))
    await route.fulfill({ status, contentType: "application/json", body: "{}" })
  })
  return requests
}

for (const status of [202, 503]) {
  test(`Given OTLP logs return ${status}, when chat saves, then text persists and telemetry excludes content`, async ({ page }) => {
    const records: LogRecord[] = []
    const exportedSpans: Span[] = []
    const requests = await interceptOtlp(page, status, records, exportedSpans)
    await page.goto("/?syncTrace=1")
    const text = "private-body-must-never-enter-diagnostics"
    const chat = await send(page, text)
    await expect.poll(() => records.some(record => body(record) === "chat.dom.updated"), { timeout: 15000 }).toBe(true)
    await expect.poll(() => exportedSpans.some(span => span.name?.startsWith("startup.")), { timeout: 15000 }).toBe(true)
    const trace = exportedSpans.find(span => span.name?.startsWith("startup."))!
    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/)
    const encoded = JSON.stringify({ records, requests })
    expect(encoded).not.toContain(text)
    expect(encoded).not.toContain(browserKey)
    const submitted = records.find(record => body(record) === "chat.submit")!
    expect(attribute(submitted, "entity.id")).toBeTruthy()
    const domUpdates = records.filter(record => body(record) === "chat.dom.updated" && attribute(record, "entity.id") === attribute(submitted, "entity.id"))
    // A 503 can retransmit the same OTLP record; distinct records still expose duplicate instrumentation.
    expect(new Set(domUpdates.map(record => JSON.stringify(record))).size).toBe(1)
    if (status === 202) expect(domUpdates).toHaveLength(1)
    expect(requests.every(url => url === endpoint || url === tracesEndpoint)).toBe(true)
    await chat.getByRole("button", { name: "Close", exact: true }).click()
    const dialog = await settings(page)
    await expect(dialog.getByRole("region", { name: "Diagnostic delivery", exact: true })).toHaveCount(0)
    await page.reload()
    await send(page, "reload-check")
    await expect(page.getByRole("dialog", { name: "Workspace chat", exact: true }).getByText(text, { exact: true })).toBeVisible()
  })
}

test("Given diagnostics are disabled, when chat saves and page hides, then no OTLP request occurs", async ({ page }) => {
  let requests = 0
  await page.route("https://telemetry.invalid/**", async route => { requests++; await route.fulfill({ status: 404 }) })
  await page.addInitScript(() => localStorage.setItem("tincanban.telemetry.enabled.v1", "false"))
  await page.goto("/?syncTrace=1")
  await send(page, "local-only-message")
  await page.waitForTimeout(2500)
  await page.goto("about:blank")
  expect(requests).toBe(0)
})

test("Given enabled OTel, when browser sends a Rusty HTTP request, then traceparent is W3C and its span exports as OTLP", async ({ page }) => {
  const exportedSpans: Span[] = []
  await interceptOtlp(page, 200, [], exportedSpans)
  const requests: Array<{ path: string; traceparent: string }> = []
  await page.route("http://127.0.0.1:47839/**", async route => {
    const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "traceparent, x-rusty-client" }
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers })
    requests.push({ path: new URL(route.request().url()).pathname, traceparent: route.request().headers().traceparent ?? "" })
    await route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify({ status: "ok" }) })
  })
  await page.goto("/")
  await send(page, "initialize-otel-before-http")
  await page.evaluate(async () => {
    const { fetchBlind } = await import("/src/sync/rustyHttp.ts")
    await fetchBlind("http://127.0.0.1:47839/health", { method: "GET" })
  })
  const healthRequest = requests.find(request => request.path === "/health")
  expect(healthRequest?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
  const parts = healthRequest!.traceparent.split("-")
  await expect.poll(() => exportedSpans.some(span => span.name === "HTTP_GET" && span.traceId === parts[1] && span.spanId === parts[2]), { timeout: 10000 }).toBe(true)
})

test("Given an owner enrolls a device without debug flags, when that device retries Rusty and reloads, then enrollment, HTTP failure and startup share one trace", async ({ page, browser }) => {
  test.setTimeout(90000)
  const phoneContext = await browser.newContext()
  const phone = await phoneContext.newPage()
  const records: LogRecord[] = [], exported: Span[] = []
  await interceptOtlp(page, 200, records, exported)
  await interceptOtlp(phone, 200, records, exported)
  let requestTraceparent = ""
  await phone.route("https://rusty.trace.invalid/**", route => {
    requestTraceparent = route.request().headers().traceparent ?? ""
    return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"fixture unavailable"}' })
  })
  try {
    await page.goto("/")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const host = page.getByRole("dialog", { name: "Device sync" })
    await host.getByRole("button", { name: "Add someone", exact: true }).click()
    await host.getByRole("button", { name: "Add my device", exact: true }).click()
    const link = await host.getByLabel("Pairing link").inputValue()
    const carrier = new URLSearchParams(new URL(link).hash.slice(1)).get("traceparent")!
    expect(carrier).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    const traceId = carrier.split("-")[1]!
    await phone.goto(link)
    const join = phone.getByRole("dialog", { name: "Device sync" })
    await join.getByRole("button", { name: "Add this device", exact: true }).waitFor()
    const replace = join.getByRole("checkbox", { name: /Replace this device.s identity/ })
    if (await replace.count()) await replace.check()
    await join.getByRole("button", { name: "Add this device", exact: true }).click()
    await host.getByRole("button", { name: "Approve device", exact: true }).click()
    await expect(join.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30000 })
    await expect(host.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30000 })
    await phone.evaluate(async () => {
      const { fetchBlind, readBlindJson } = await import("/src/sync/rustyHttp.ts")
      const { traceDiagnosticOperation } = await import("/src/sync/telemetry.ts")
      await traceDiagnosticOperation("rusty.retry", {}, async diagnosticContext => {
        try { await readBlindJson(await fetchBlind("https://rusty.trace.invalid/status", { diagnosticContext })) }
        catch { /* Expected unavailable-server state. */ }
      })
    })
    expect(requestTraceparent.split("-")[1]).toBe(traceId)
    await phone.evaluate(async () => (await import("/src/sync/telemetry.ts")).retryTelemetry())
    await expect.poll(() => exported.some(span => span.name === "enrollment.guest" && span.traceId === traceId), { timeout: 15000 }).toBe(true)
    await phone.reload()
    await expect(phone.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled()
    await phone.evaluate(async () => (await import("/src/sync/telemetry.ts")).retryTelemetry())
    await page.evaluate(async () => (await import("/src/sync/telemetry.ts")).retryTelemetry())
    await expect.poll(() => exported.some(span => span.name === "enrollment.host" && span.traceId === traceId), { timeout: 15000 }).toBe(true)
    await expect.poll(() => exported.some(span => span.name === "enrollment.guest" && span.traceId === traceId), { timeout: 15000 }).toBe(true)
    const guest = exported.find(span => span.name === "enrollment.guest" && span.traceId === traceId)!
    expect(guest.parentSpanId).toBe(carrier.split("-")[2])
    await expect.poll(() => exported.some(span => span.name === "startup.history-reclassification" && span.traceId === traceId && span.parentSpanId), { timeout: 15000 }).toBe(true)
    const reclassification = exported.find(span => span.name === "startup.history-reclassification" && span.traceId === traceId)!
    expect(exported.some(span => span.name === "startup.reclassify-load-document" && span.parentSpanId === reclassification.spanId)).toBe(true)
    expect(exported.some(span => span.traceId === traceId && span.name === "HTTP_GET" &&
      span.attributes?.some(value => value.key === "http.response.status_code" && Number(value.value.intValue) === 503))).toBe(true)
    expect(records.some(record => body(record) === "enrollment.guest.completed" && record.traceId === traceId)).toBe(true)
    expect(JSON.stringify({ records, exported })).not.toContain(new URLSearchParams(new URL(link).hash.slice(1)).get("secret")!)
  } finally { await phoneContext.close() }
})

test("Given legacy collector settings, when deployment loads, then only the deployed collector receives events", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("tincanban.telemetry.v2", JSON.stringify({
    enabled: true, endpoint: "https://legacy.invalid/events", project: "legacy", browserKey: "old-browser-fixture-key", level: "all", sampleRate: 1,
  })))
  let legacyRequests = 0
  let deployedRequests = 0
  await page.route("https://legacy.invalid/**", async route => { legacyRequests++; await route.fulfill({ status: 404 }) })
  await page.route("https://telemetry.invalid/**", async route => { deployedRequests++; await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }) })
  await page.goto("/?syncTrace=1")
  await send(page, "deployment-destination")
  await expect.poll(() => deployedRequests).toBeGreaterThan(0)
  expect(legacyRequests).toBe(0)
})

for (const rejection of [401, 404]) test(`Given OTLP intake returns ${rejection}, when chat saves, then chat persists and host opt-out survives reload without a diagnostics panel`, async ({ page }) => {
  let requests = 0
  await page.route("https://telemetry.invalid/**", async route => { requests++; await route.fulfill({ status: rejection }) })
  await page.goto("/?syncTrace=1")
  const chat = await send(page, "message-survives-rejection")
  await expect.poll(() => requests).toBeGreaterThan(0)
  await chat.getByRole("button", { name: "Close", exact: true }).click()
  const dialog = await settings(page)
  await expect(dialog.getByRole("region", { name: "Diagnostic delivery", exact: true })).toHaveCount(0)
  await page.evaluate(async () => (await import("/src/sync/telemetryConfig.ts")).setTelemetryEnabled(false))
  await page.reload()
  expect(await page.evaluate(async () => (await import("/src/sync/telemetryConfig.ts")).telemetryConfig().enabled)).toBe(false)
  await settings(page)
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Dismiss" }).click()
  await send(page, "opt-out-survives-reload")
  expect(requests).toBeGreaterThan(0)
})

test("Given unavailable preference storage, when device opts out, then host preference reports failure and retains its prior setting", async ({ page }) => {
  await page.route("https://telemetry.invalid/**", async route => await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }))
  await page.goto("/?syncTrace=1")
  await settings(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) {
      if (key === "tincanban.telemetry.enabled.v1") throw new Error("storage full")
      original.call(this, key, value)
    }
  })
  const preference = await page.evaluate(async () => {
    const { setTelemetryEnabled, telemetryConfig } = await import("/src/sync/telemetryConfig.ts")
    let error = ""
    try { setTelemetryEnabled(false) } catch (cause) { error = String(cause) }
    return { error, enabled: telemetryConfig().enabled }
  })
  expect(preference.error).toContain("could not be saved")
  expect(preference.enabled).toBe(true)
})

test("Given ordinary app use, when a user opens the board, stays active and hits an error, then analytics and error text export without routine mesh logs", async ({ page }) => {
  const analytics: Array<{ schema_version: number; events: Array<{ event: string; path: string }> }> = []
  const records: LogRecord[] = []
  await interceptOtlp(page, 200, records)
  await page.route("https://telemetry.invalid/events", async route => {
    analytics.push(route.request().postDataJSON())
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"accepted":1}' })
  })
  await page.clock.install()
  await page.goto("/?secret=must-not-leak#private-board")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled()
  await expect.poll(() => analytics.flatMap(batch => batch.events).filter(event => event.event === "page_view").length).toBe(1)
  await page.evaluate(async () => {
    const { meshTrace } = await import("/src/sync/meshTrace.ts")
    for (let i = 0; i < 20; i++) meshTrace("gossip.packet", { neighbors: 1 })
    window.dispatchEvent(new ErrorEvent("error", { error: new TypeError("analytics acceptance failure token=secret-token"), message: "analytics acceptance failure" }))
  })
  await page.clock.runFor(4000)
  await expect.poll(() => records.some(record => body(record) === "browser.error")).toBe(true)
  const failure = records.find(record => body(record) === "browser.error")!
  expect(attribute(failure, "exception.message")).toBe("analytics acceptance failure token=[REDACTED]")
  expect(attribute(failure, "exception.stacktrace")).toBeTruthy()
  expect(records.some(record => body(record) === "gossip.packet")).toBe(false)
  await page.clock.runFor(30_000)
  await expect.poll(() => analytics.flatMap(batch => batch.events).some(event => event.event === "active_read")).toBe(true)
  expect(analytics.every(batch => batch.schema_version === 1)).toBe(true)
  expect(analytics.flatMap(batch => batch.events).every(event => event.path === "/app")).toBe(true)
  expect(JSON.stringify(analytics)).not.toMatch(/must-not-leak|private-board|secret-token|workspace_id|device_id/)
})
