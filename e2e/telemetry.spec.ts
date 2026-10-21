import { expect, test, type Page } from "./support/coverage"

type Attribute = { key: string; value: Record<string, unknown> }
type LogRecord = { body?: Record<string, unknown>; attributes?: Attribute[] }
type OtlpLogs = { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: LogRecord[] }> }> }
type Span = { name?: string; traceId?: string; spanId?: string; attributes?: Attribute[] }
type OtlpTraces = { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Span[] }> }> }
const endpoint = "https://telemetry.invalid/v1/logs"
const tracesEndpoint = "https://telemetry.invalid/v1/traces"
const browserKey = "public-browser-fixture-key-0123456789"

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
  await page.goto("/?syncTrace=1")
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
