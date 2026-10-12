import { expect, test } from "./support/coverage"

test("Given an intake withholding every acknowledgement, When a mobile board opens and reloads, Then the board becomes usable before any acknowledgement", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  let acknowledge!: () => void
  const response = new Promise<void>(resolve => { acknowledge = resolve })
  const events: Array<{ event: string; operation: string }> = []
  await page.route("https://telemetry.invalid/events", async route => {
    const batch = route.request().postDataJSON()
    events.push(...batch.events)
    await response
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ accepted: batch.events.length }) }).catch(() => {})
  })
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 10000 })
    await expect.poll(() => events.some(event => event.event === "startup.phase.completed" && event.operation === "access-ui-commit")).toBe(true)
    events.length = 0
    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 10000 })
    await expect.poll(() => events.some(event => event.event === "startup.phase.completed" && event.operation === "access-ui-commit")).toBe(true)
  } finally { acknowledge() }
})

for (const status of [202, 503]) for (const policyChanged of [false, true]) test(`Given startup debug, intake ${status} and ${policyChanged ? "changed" : "unchanged"} policy, When a mobile page reloads, Then phase checkpoints identify actual work and the board stays usable`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const events: Array<{ event: string; operation: string; device_id: string; attrs: Record<string, unknown> }> = []
  await page.route("https://telemetry.invalid/events", async route => {
    const batch = route.request().postDataJSON()
    events.push(...batch.events)
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ accepted: batch.events.length }) })
  })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  await expect.poll(() => events.some(event => event.event === "startup.phase.completed" && event.attrs.stage === "start-sync")).toBe(true)
  if (policyChanged) await page.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
    const storage = (await import("/src/storage.ts")).defaultStorage
    const A = await import("/@id/@automerge/automerge/slim")
    const doc = app.getActiveDoc()!
    const evidence = (await storage.loadCausalEvidence(doc.id))!
    evidence.admissionCheckpoint!.policy = "previous-policy"
    await storage.commitWorkspace(doc.id, doc, A.save(doc), [], undefined, evidence)
  })
  const before = events.length
  await page.reload()
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  await expect.poll(() => events.slice(before).some(event => event.event === "startup.phase.completed" && event.attrs.stage === "start-sync")).toBe(true)
  await expect.poll(() => events.slice(before).some(event => event.event === "startup.phase.completed" && event.operation === "access-ui-commit")).toBe(true)
  for (const stage of ["entry", "policy-wasm", "admission-worker-init", "automerge-wasm", "identity-load", "initial-workspace-load", "workspace-preview", "history-reclassification", "reclassify-reuse-projection", "workspace-projection", "personal-root-load", "start-sync", "access-active-workspace", "access-serialize", "access-policy", "access-worker-wasm", "access-worker-decode", "access-worker-decide", "access-current-owner", "access-ui-commit"]) {
    await expect.poll(() => events.slice(before).some(event => event.event === "startup.phase.started" && event.operation === stage), { message: `Missing checkpoint: ${stage}` }).toBe(true)
  }
  expect(events.slice(before).some(event => event.event === "startup.phase.started" && event.operation === "reclassify-admit-history")).toBe(policyChanged)
  expect(events.slice(before).some(event => event.event === "startup.phase.started" && event.operation === "reclassify-commit")).toBe(policyChanged)
  expect(events.slice(before).find(event => event.event === "startup.phase.completed" && event.operation === "access-serialize")?.attrs.bytes).toBeGreaterThan(0)
  expect(events.slice(before).find(event => event.event === "startup.phase.completed" && event.operation === "access-worker-wasm")?.attrs.bytes).toBeGreaterThan(0)
  expect(events.slice(before).find(event => event.attrs.stage === "entry")?.device_id).toBeTruthy()
  expect(JSON.stringify(events)).not.toContain("Safari/")
})
