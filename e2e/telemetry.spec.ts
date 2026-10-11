import { expect, test, type Page } from "./support/coverage"

type Diagnostic = Record<string, unknown> & { event: string; entity_id: string; trace_id: string }
type Batch = { schema_version: number; project: string; stream: string; source: string; events: Diagnostic[] }
const endpoint = "https://telemetry.invalid/events"
const browserKey = "public-browser-fixture-key-0123456789"

async function settings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
  const identity = dialog.getByRole("tab", { name: "Identity", exact: true })
  if (await identity.count()) await identity.click()
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

for (const status of [202, 503]) {
  test(`Given diagnostics return ${status}, when chat saves, then text persists and telemetry excludes content`, async ({ page }) => {
    const batches: Batch[] = []
    await page.route(endpoint, async route => {
      expect(route.request().headers().authorization).toBe(`Bearer ${browserKey}`)
      const batch = route.request().postDataJSON() as Batch
      batches.push(batch)
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ accepted: batch.events.length }) })
    })
    await page.goto("/")
    const text = "private-body-must-never-enter-diagnostics"
    const chat = await send(page, text)
    await expect.poll(() => batches.flatMap(batch => batch.events).some(event => event.event === "chat.dom.updated"), { timeout: 15000 }).toBe(true)
    expect(JSON.stringify(batches)).not.toContain(text)
    expect(JSON.stringify(batches)).not.toContain(browserKey)
    const events = batches.flatMap(batch => batch.events)
    const submitted = events.find(event => event.event === "chat.submit")!
    expect(submitted.entity_id).toBeTruthy()
    expect(submitted.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(events.some(event => event.event === "chat.persisted" && event.entity_id === submitted.entity_id && event.trace_id === submitted.trace_id)).toBe(true)
    expect(events.filter(event => event.event === "chat.dom.updated" && event.entity_id === submitted.entity_id)).toHaveLength(1)
    expect(batches.every(batch => batch.schema_version === 2 && batch.stream === "telemetry" && batch.project === "tincanban")).toBe(true)
    for (const event of events) expect(Object.keys(event).sort()).toEqual([
      "attrs", "build", "component", "device_id", "duration_ms", "entity_id", "entity_type", "event", "event_id", "occurred_at", "operation", "parent_span_id", "session_id", "span_id", "status", "trace_id", "workspace_id",
    ])
    await chat.getByRole("button", { name: "Close", exact: true }).click()
    const dialog = await settings(page)
    await expect(dialog.getByRole("checkbox", { name: "Send diagnostics from this device" })).toBeChecked()
    await dialog.getByRole("tab", { name: "Connections", exact: true }).click()
    await expect(dialog.getByRole("status", { name: "Diagnostic delivery" })).toContainText(status === 503 ? "pending" : "ready")
    if (status === 503) await expect(dialog.getByRole("alert")).toContainText("Intake unavailable")
    await page.reload()
    await send(page, "reload-check")
    await expect(page.getByRole("dialog", { name: "Workspace chat", exact: true }).getByText(text, { exact: true })).toBeVisible()
  })
}

test("Given diagnostics are disabled, when chat saves and page hides, then no intake request occurs", async ({ page }) => {
  let requests = 0
  await page.route("**/events", async route => { requests++; await route.fulfill({ status: 404 }) })
  await page.addInitScript(() => localStorage.setItem("tincanban.telemetry.enabled.v1", "false"))
  await page.goto("/")
  await send(page, "local-only-message")
  await page.waitForTimeout(2500)
  await page.goto("about:blank")
  expect(requests).toBe(0)
})

test("Given legacy collector settings, when deployment loads, then only the deployed collector receives events", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("tincanban.telemetry.v2", JSON.stringify({
    enabled: true, endpoint: "https://legacy.invalid/events", project: "legacy", browserKey: "old-browser-fixture-key", level: "all", sampleRate: 1,
  })))
  let legacyRequests = 0
  let deployedRequests = 0
  await page.route("https://legacy.invalid/**", async route => { legacyRequests++; await route.fulfill({ status: 404 }) })
  await page.route(endpoint, async route => { deployedRequests++; const batch = route.request().postDataJSON() as Batch; await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: batch.events.length }) }) })
  await page.goto("/")
  await send(page, "deployment-destination")
  await expect.poll(() => deployedRequests).toBeGreaterThan(0)
  expect(legacyRequests).toBe(0)
})

for (const rejection of [401, 404]) test(`Given intake returns ${rejection}, when chat saves, then retry stops and user can disable diagnostics`, async ({ page }) => {
  let requests = 0
  await page.route(endpoint, async route => { requests++; await route.fulfill({ status: rejection }) })
  await page.goto("/")
  const chat = await send(page, "message-survives-404")
  await expect.poll(() => requests).toBe(1)
  await chat.getByRole("button", { name: "Close", exact: true }).click()
  const dialog = await settings(page)
  await dialog.getByRole("tab", { name: "Connections", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText(`HTTP ${rejection}`)
  await dialog.getByRole("tab", { name: "Identity", exact: true }).click()
  await dialog.getByRole("checkbox", { name: "Send diagnostics from this device" }).uncheck()
  await page.reload()
  await expect((await settings(page)).getByRole("checkbox", { name: "Send diagnostics from this device" })).not.toBeChecked()
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Dismiss" }).click()
  await send(page, "opt-out-survives-reload")
  expect(requests).toBe(1)
})

test("Given unavailable preference storage, when device opts out, then the checkbox reverts and reports the failure", async ({ page }) => {
  await page.route(endpoint, async route => { const batch = route.request().postDataJSON() as Batch; await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: batch.events.length }) }) })
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
  await expect(dialog.getByRole("alert")).toContainText("could not be saved")
  await expect(dialog.getByRole("checkbox", { name: "Send diagnostics from this device" })).toBeChecked()
})
