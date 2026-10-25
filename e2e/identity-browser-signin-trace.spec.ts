import { expect, test } from "./support/coverage"

test.use({ trace: "off", video: "off", screenshot: "off" })

type Attribute = { key: string; value: Record<string, unknown> }
type LogRecord = { body?: { stringValue?: string }; attributes?: Attribute[]; traceId?: string; spanId?: string }
type Span = { name?: string; traceId?: string; spanId?: string; parentSpanId?: string }
type OtlpLogs = { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: LogRecord[] }> }> }
type OtlpTraces = { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Span[] }> }> }

const identityOrigin = process.env.IDENTITY_E2E_ORIGIN ?? "http://127.0.0.1:4190"
const browserKey = "public-browser-fixture-key-0123456789"

test("Given an enabled local diagnostic collector, when Identity approves browser sign-in across a same-tab redirect, then request and callback logs share one trace", async ({ page, context }) => {
  test.setTimeout(90_000)
  const appOrigin = process.env.TINCANBAN_E2E_ORIGIN ?? `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? 48937}`
  const logs: LogRecord[] = []
  const spans: Span[] = []
  await page.route("https://telemetry.invalid/v1/logs", async route => {
    const headers = route.request().headers()
    expect(headers.authorization).toBe(`Bearer ${browserKey}`)
    expect(headers["x-tinsink-project"]).toBe("tincanban")
    expect(headers["x-tinsink-source"]).toBe("browser")
    logs.push(...logRecords(route.request().postDataJSON() as OtlpLogs))
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  })
  await page.route("https://telemetry.invalid/v1/traces", async route => {
    spans.push(...traceSpans(route.request().postDataJSON() as OtlpTraces))
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  })

  const portal = await context.newPage()
  await portal.goto(identityOrigin)
  await portal.getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.locator('#create-form input[name="displayName"]').fill("Trace Acceptance Owner")
  await portal.locator("#create-form").getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.getByRole("heading", { name: "Save your recovery" }).waitFor()
  const download = portal.waitForEvent("download")
  await portal.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
  await download
  await portal.locator('input[name="saved-words"]').check()
  await portal.getByRole("button", { name: "Continue to identity", exact: true }).click()
  await portal.getByRole("heading", { name: "Trace Acceptance Owner" }).waitFor()

  await page.goto(appOrigin)
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
  await page.getByLabel("Allow this app to use the Identity shown above.").check()
  await page.getByRole("button", { name: "Approve app device", exact: true }).click()

  const decision = page.getByRole("dialog", { name: "Identity profile", exact: true })
  await expect(decision.getByRole("heading", { name: "Join Trace Acceptance Owner?" })).toBeVisible({ timeout: 30_000 })
  await decision.getByRole("button", { name: "Download active workspace backup", exact: true }).click()
  await decision.getByLabel("I understand this changes the active Identity and may leave local boards inaccessible.").check()
  await decision.getByRole("button", { name: "Continue with this Identity", exact: true }).click()
  await expect.poll(async () => (await decision.count()) === 0 || (await decision.getByRole("alert").count()) > 0, { timeout: 30_000 }).toBe(true)
  if (await decision.count()) {
    const userVisibleError = (await decision.getByRole("alert").textContent().catch(() => ""))?.trim() ?? ""
    const safeToReport = /^[A-Za-z0-9 .,!?'-]{1,200}$/u.test(userVisibleError)
    console.log("Post-approval adoption outcome", safeToReport ? userVisibleError : "Error message omitted (sensitive or unbounded text)")
  }
  await expect(decision).toHaveCount(0)
  await page.evaluate(async () => (await import("/src/sync/telemetry.ts")).retryTelemetry())
  await expect.poll(() => logs.some(log => log.body?.stringValue === "identity.browser_signin" && attribute(log, "sync.phase") === "callback" && attribute(log, "identity.signin.outcome") === "verified"), { timeout: 15_000 }).toBe(true)
  await expect.poll(() => logs.some(log => log.body?.stringValue === "identity.browser_signin" && attribute(log, "sync.phase") === "adoption" && attribute(log, "identity.signin.outcome") === "completed"), { timeout: 15_000 }).toBe(true)

  const requestLog = logs.find(log => log.body?.stringValue === "identity.browser_signin" && attribute(log, "sync.phase") === "request" && attribute(log, "identity.signin.outcome") === "completed")
  const callbackLog = logs.find(log => log.body?.stringValue === "identity.browser_signin" && attribute(log, "sync.phase") === "callback" && attribute(log, "identity.signin.outcome") === "verified")
  const adoptionLog = logs.find(log => log.body?.stringValue === "identity.browser_signin" && attribute(log, "sync.phase") === "adoption" && attribute(log, "identity.signin.outcome") === "completed")
  const callbackDiagnosticState = await page.evaluate(async () => {
    const contexts = await import("/src/sync/diagnosticTraceContext.ts")
    const traceparent = contexts.diagnosticTraceparent(contexts.diagnosticContinuation())
    const { telemetryStatus } = await import("/src/sync/telemetry.ts")
    const status = telemetryStatus()
    return { continuationTraceId: traceparent?.split("-")[1] ?? "missing", state: status.state, queued: status.queued, dropped: status.dropped }
  })
  console.log("Callback diagnostic availability", {
    requestTraceId: requestLog?.traceId ?? "missing",
    callbackLogTraceId: callbackLog?.traceId ?? "missing",
    callbackContinuationTraceId: callbackDiagnosticState.continuationTraceId,
    operationSpanNames: spans.filter(span => span.name?.startsWith("identity.browser_signin.")).map(span => span.name),
    telemetry: { state: callbackDiagnosticState.state, queued: callbackDiagnosticState.queued, dropped: callbackDiagnosticState.dropped },
  })
  expect(requestLog?.traceId).toMatch(/^[0-9a-f]{32}$/u)
  await expect.poll(() => spans.some(span => span.name === "identity.browser_signin.request" && span.traceId === requestLog?.traceId), { timeout: 15_000 }).toBe(true)
  await expect.poll(() => spans.some(span => span.name === "identity.browser_signin.callback" && span.traceId === requestLog?.traceId), { timeout: 15_000 }).toBe(true)
  const callbackSpan = spans.find(span => span.name === "identity.browser_signin.callback")
  expect(callbackSpan?.traceId).toBe(requestLog?.traceId)
  expect(callbackLog?.traceId).toBe(requestLog?.traceId)
  expect(adoptionLog?.traceId).toBe(requestLog?.traceId)

  await portal.close()
})

function logRecords(payload: OtlpLogs): LogRecord[] {
  return (payload.resourceLogs ?? []).flatMap(resource => (resource.scopeLogs ?? []).flatMap(scope => scope.logRecords ?? []))
}

function traceSpans(payload: OtlpTraces): Span[] {
  return (payload.resourceSpans ?? []).flatMap(resource => (resource.scopeSpans ?? []).flatMap(scope => scope.spans ?? []))
}

function attribute(record: LogRecord, key: string): unknown {
  const value = record.attributes?.find(item => item.key === key)?.value
  return value && Object.values(value)[0]
}
