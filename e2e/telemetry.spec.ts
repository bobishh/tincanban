import { expect, test, type Page } from "./support/coverage"

type Attribute = { key: string; value: Record<string, unknown> }
type LogRecord = { body?: Record<string, unknown>; attributes?: Attribute[] }
type OtlpLogs = { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: LogRecord[] }> }> }
type Span = { name?: string; traceId?: string; spanId?: string; attributes?: Attribute[] }
type OtlpTraces = { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Span[] }> }> }
const endpoint = "https://telemetry.invalid/v1/logs"
const tracesEndpoint = "https://telemetry.invalid/v1/traces"
const browserKey = "public-browser-fixture-key-0123456789"

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
  await expect(dialog.getByRole("checkbox", { name: "Send diagnostics from this device" })).toBeVisible()
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
    await page.goto("/")
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
    expect(records.filter(record => body(record) === "chat.dom.updated" && attribute(record, "entity.id") === attribute(submitted, "entity.id"))).toHaveLength(1)
    expect(requests.every(url => url === endpoint || url === tracesEndpoint)).toBe(true)
    await chat.getByRole("button", { name: "Close", exact: true }).click()
    const dialog = await settings(page)
    await expect(dialog.getByRole("checkbox", { name: "Send diagnostics from this device" })).toBeChecked()
    await dialog.getByRole("tab", { name: "Workspace", exact: true }).click()
    await expect(dialog.getByRole("status", { name: "Diagnostic delivery" })).toContainText(status === 503 ? /OTLP|Exporting diagnostics|Waiting to export/ : "Last OTLP response received")
    if (status === 503) await expect(dialog.getByRole("region", { name: "Diagnostic delivery", exact: true })).toBeVisible()
    await page.reload()
    await send(page, "reload-check")
    await expect(page.getByRole("dialog", { name: "Workspace chat", exact: true }).getByText(text, { exact: true })).toBeVisible()
  })
}

test("Given diagnostics are disabled, when chat saves and page hides, then no OTLP request occurs", async ({ page }) => {
  let requests = 0
  await page.route("https://telemetry.invalid/**", async route => { requests++; await route.fulfill({ status: 404 }) })
  await page.addInitScript(() => localStorage.setItem("tincanban.telemetry.enabled.v1", "false"))
  await page.goto("/")
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

test("Given legacy collector settings, when deployment loads, then only the deployed collector receives events", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("tincanban.telemetry.v2", JSON.stringify({
    enabled: true, endpoint: "https://legacy.invalid/events", project: "legacy", browserKey: "old-browser-fixture-key", level: "all", sampleRate: 1,
  })))
  let legacyRequests = 0
  let deployedRequests = 0
  await page.route("https://legacy.invalid/**", async route => { legacyRequests++; await route.fulfill({ status: 404 }) })
  await page.route("https://telemetry.invalid/**", async route => { deployedRequests++; await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }) })
  await page.goto("/")
  await send(page, "deployment-destination")
  await expect.poll(() => deployedRequests).toBeGreaterThan(0)
  expect(legacyRequests).toBe(0)
})

for (const rejection of [401, 404]) test(`Given OTLP intake returns ${rejection}, when chat saves, then export failure is visible and user can disable diagnostics`, async ({ page }) => {
  let requests = 0
  await page.route("https://telemetry.invalid/**", async route => { requests++; await route.fulfill({ status: rejection }) })
  await page.goto("/")
  const chat = await send(page, "message-survives-rejection")
  await expect.poll(() => requests).toBeGreaterThan(0)
  await chat.getByRole("button", { name: "Close", exact: true }).click()
  const dialog = await settings(page)
  await expect(dialog.getByRole("region", { name: "Diagnostic delivery", exact: true }).getByRole("alert")).toContainText(/OTLP (log|trace) export failed/)
  await dialog.getByRole("checkbox", { name: "Send diagnostics from this device" }).uncheck()
  await page.reload()
  await expect((await settings(page)).getByRole("checkbox", { name: "Send diagnostics from this device" })).not.toBeChecked()
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Dismiss" }).click()
  await send(page, "opt-out-survives-reload")
  expect(requests).toBeGreaterThan(0)
})

test("Given unavailable preference storage, when device opts out, then the checkbox reverts and reports the failure", async ({ page }) => {
  await page.route("https://telemetry.invalid/**", async route => await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }))
  await page.goto("/")
  const dialog = await settings(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) {
      if (key === "tincanban.telemetry.enabled.v1") throw new Error("storage full")
      original.call(this, key, value)
    }
  })
  await dialog.getByRole("checkbox", { name: "Send diagnostics from this device" }).click()
  await expect(dialog.getByRole("region", { name: "Device diagnostics", exact: true }).getByRole("alert")).toContainText("could not be saved")
  await expect(dialog.getByRole("checkbox", { name: "Send diagnostics from this device" })).toBeChecked()
})
