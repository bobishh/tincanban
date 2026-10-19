import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given a mobile board with over 312k signed operations, When cold loading and retrying a failed access update, Then the saved card remains available", async ({ page }, info) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    const NativeWorker = Worker
    const names: string[] = []
    ;(window as Window & { __policyWorkers?: string[] }).__policyWorkers = names
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (options?.name?.startsWith("workspace-")) names.push(options.name)
      }
    }
  })
  await page.goto("/")
  await createJobSearchWorkspace(page, "Mobile history")
  const fixture = await page.evaluate(async () => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const app = useTincanban()
    await app.whenReady()
    const doc = app.getActiveDoc()!
    const lead = Object.values(doc.entities).find(entity => entity.kind === "column" && entity.title === "Lead")!
    await app.executeCommandAsync({ kind: "createItem", id: "mobile-history-card", parentId: lead.id,
      title: "Memory check — Engineer", body: "Description line.\n".repeat(18400) })
    const saved = app.getActiveDoc()!
    return { workspaceId: saved.id, heads: A.getHeads(saved).sort(), operations: A.getChangesMetaSince(saved, []).reduce((count, change) => count + change.maxOp - change.startOp + 1, 0) }
  })
  expect(fixture.operations).toBeGreaterThan(312_000)
  await page.reload()
  const card = page.locator('[data-item-id="mobile-history-card"]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText("Memory check")
  // Saved cards appear before history and access checks finish on reload.
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
  expect(await page.evaluate(() => (window as Window & { __policyWorkers?: string[] }).__policyWorkers))
    .toEqual(["workspace-admission"])
  // Current admission reuses the saved projection without a write. Exercise
  // failed persistence only when an older policy requires reclassification.
  await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    const storage = (await import("/src/storage.ts")).defaultStorage
    const A = await import("/@id/@automerge/automerge/slim")
    const doc = app.getActiveDoc()!
    const evidence = (await storage.loadCausalEvidence(doc.id))!
    evidence.admissionCheckpoint!.policy = "previous-policy"
    await storage.withWorkspaceTransaction(doc.id, transaction =>
      transaction.commitWorkspace(doc, A.save(doc), [], undefined, evidence))
    ;(window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true
  })
  const failure = await page.evaluate(async workspaceId => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    try { await useTincanban().reclassifyWorkspace(workspaceId); return "unexpected success" }
    catch (error) { return String(error) }
  }, fixture.workspaceId)
  expect(failure).toMatch(/Storage failure injected/)
  await expect(card).toBeVisible()
  await expect(page.getByRole("alert")).toContainText(/Access update pending|could not be reclassified/i)
  await page.evaluate(async workspaceId => {
    delete (window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__
    await (await import("/src/test/stateFixture.ts")).useTincanban().reclassifyWorkspace(workspaceId)
  }, fixture.workspaceId)
  await page.reload()
  await expect(card).toBeVisible({ timeout: 30_000 })
  expect(await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    await app.whenReady()
    return (await import("/@id/@automerge/automerge/slim")).getHeads(app.getActiveDoc()!).sort()
  })).toEqual(fixture.heads)
  await page.screenshot({ path: info.outputPath("mobile-large-history.png") })
})
