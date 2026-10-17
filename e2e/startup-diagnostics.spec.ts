import { expect, test } from "./support/coverage"
import type { Page } from "@playwright/test"

type Attribute = { key: string; value: Record<string, unknown> }
type LogRecord = { body?: Record<string, unknown>; attributes?: Attribute[] }
type OtlpLogs = { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: LogRecord[] }> }> }
const logsUrl = "https://telemetry.invalid/v1/logs"
const tracesUrl = "https://telemetry.invalid/v1/traces"
function records(payload: OtlpLogs): LogRecord[] {
  return (payload.resourceLogs ?? []).flatMap(resource => (resource.scopeLogs ?? []).flatMap(scope => scope.logRecords ?? []))
}
function event(record: LogRecord): string | undefined { return record.body?.stringValue as string | undefined }
function attr(record: LogRecord, name: string): unknown {
  const value = record.attributes?.find(item => item.key === name)?.value
  return value && Object.values(value)[0]
}
async function intercept(page: Page, status: number, output: LogRecord[], wait?: Promise<void>) {
  await page.route(logsUrl, async route => {
    output.push(...records(route.request().postDataJSON() as OtlpLogs))
    await wait
    await route.fulfill({ status, contentType: "application/json", body: "{}" }).catch(() => {})
  })
  await page.route(tracesUrl, async route => await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }))
}

test("Given an intake withholding every acknowledgement, When a mobile board opens and reloads, Then the board becomes usable before any acknowledgement", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let acknowledge!: () => void
  const response = new Promise<void>(resolve => { acknowledge = resolve })
  const entries: LogRecord[] = []
  await intercept(page, 200, entries, response)
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 10000 })
    acknowledge()
    await expect.poll(() => entries.some(item => event(item) === "startup.phase.completed" && attr(item, "code.operation") === "access-ui-commit")).toBe(true)
    entries.length = 0
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 10000 })
  } finally { acknowledge() }
})

for (const policyChanged of [false, true]) test(`Given startup debug and ${policyChanged ? "changed" : "unchanged"} policy, When a mobile page reloads, Then phase checkpoints identify actual work and the board stays usable`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const entries: LogRecord[] = []
  await intercept(page, 200, entries)
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  await expect.poll(() => entries.some(item => event(item) === "startup.phase.completed" && attr(item, "startup.stage") === "start-sync")).toBe(true)
  if (policyChanged) await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    const storage = (await import("/src/storage.ts")).defaultStorage
    const A = await import("/@id/@automerge/automerge/slim")
    const doc = app.getActiveDoc()!
    const evidence = (await storage.loadCausalEvidence(doc.id))!
    evidence.admissionCheckpoint!.policy = "previous-policy"
    await storage.commitWorkspace(doc.id, doc, A.save(doc), [], undefined, evidence)
  })
  const before = entries.length
  await page.reload()
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  await expect.poll(() => entries.slice(before).some(item => event(item) === "startup.phase.completed" && attr(item, "startup.stage") === "start-sync")).toBe(true)
  await expect.poll(() => entries.slice(before).some(item => event(item) === "startup.phase.completed" && attr(item, "code.operation") === "access-ui-commit")).toBe(true)
  for (const stage of ["entry", "policy-wasm", "admission-worker-init", "automerge-wasm", "identity-load", "initial-workspace-load", "workspace-preview", "history-reclassification", "reclassify-reuse-projection", "workspace-projection", "personal-root-load", "start-sync", "access-active-workspace", "access-serialize", "access-policy", "access-worker-wasm", "access-worker-decode", "access-worker-decide", "access-current-owner", "access-ui-commit"]) {
    await expect.poll(() => entries.slice(before).some(item => event(item) === "startup.phase.started" && attr(item, "code.operation") === stage), { message: `Missing checkpoint: ${stage}` }).toBe(true)
  }
  expect(entries.slice(before).some(item => event(item) === "startup.phase.started" && attr(item, "code.operation") === "reclassify-admit-history")).toBe(policyChanged)
  expect(entries.slice(before).some(item => event(item) === "startup.phase.started" && attr(item, "code.operation") === "reclassify-commit")).toBe(policyChanged)
  expect(Number(attr(entries.slice(before).find(item => event(item) === "startup.phase.completed" && attr(item, "code.operation") === "access-serialize")!, "sync.bytes"))).toBeGreaterThan(0)
  expect(Number(attr(entries.slice(before).find(item => event(item) === "startup.phase.completed" && attr(item, "code.operation") === "access-worker-wasm")!, "sync.bytes"))).toBeGreaterThan(0)
  expect(entries.slice(before).find(item => attr(item, "startup.stage") === "entry")).toBeTruthy()
  expect(JSON.stringify(entries)).not.toContain("Safari/")
})

test("Given startup diagnostics intake rejects batches, when a mobile board loads and reloads, then local workspace access remains usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const entries: LogRecord[] = []
  await intercept(page, 503, entries)
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  await page.reload()
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
})
