import { expect, test } from "./support/coverage"
import { populatedBoard } from "./support/detailedBoard"

test("Given mesh computation pending in its worker, when searching cards, then board responds before computation completes", async ({ page }) => {
  await populatedBoard(page)
  const workerCreated = page.waitForEvent("worker", worker => worker.url().includes("meshScopeWorker"))
  await page.evaluate(async () => {
    const { createBackgroundMeshScope } = await import("/src/sync/meshScopeClient.ts")
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const runtime = createBackgroundMeshScope(state.activeWorkspace.id, "test-secret")
    await runtime.startDocumentSync("test-local", "test-remote")
    Object.assign(window, { testMeshScope: runtime, testMeshDocument: await state.readWorkspaceBytes(state.activeWorkspace.id) })
  })
  const worker = await workerCreated
  let finished = false
  const busy = worker.evaluate(() => {
    const until = Date.now() + 2_000
    while (Date.now() < until) { /* deterministic pending CPU work outside UI */ }
  }).then(() => { finished = true })
  const publishing = page.evaluate(async () => {
    const fixture = window as unknown as { testMeshScope: import("@meta-uber/mesh-runtime").MeshScopeExecutor; testMeshDocument: Uint8Array }
    return Boolean((await fixture.testMeshScope.preparePublish(fixture.testMeshDocument, undefined, undefined, undefined, undefined)).documentFrame)
  })
  await page.getByRole("searchbox", { name: "Search cards" }).fill("missing-while-syncing")
  await expect(page.getByText("No matching cards", { exact: true })).toBeVisible()
  expect(finished).toBe(false)
  await busy
  expect(await publishing).toBe(true)
  await page.evaluate(async () => {
    await (window as unknown as { testMeshScope: import("@meta-uber/mesh-runtime").MeshScopeExecutor }).testMeshScope.free?.()
  })
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(page.locator(".board .lead-card")).toHaveCount(55)
})

test("Given malformed mesh data, when worker rejects it, then board remains usable and valid computation can retry", async ({ page }) => {
  await populatedBoard(page)
  const result = await page.evaluate(async () => {
    const { createBackgroundMeshScope } = await import("/src/sync/meshScopeClient.ts")
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const runtime = createBackgroundMeshScope(state.activeWorkspace.id, "test-secret")
    await runtime.startDocumentSync("test-local", "test-remote")
    let rejected = false
    try { await runtime.preparePublish(new Uint8Array([1, 2, 3]), undefined, undefined, undefined, undefined) }
    catch { rejected = true }
    const plan = await runtime.preparePublish(await state.readWorkspaceBytes(state.activeWorkspace.id), undefined, undefined, undefined, undefined)
    await runtime.free?.()
    return { rejected, retried: Boolean(plan.documentFrame) }
  })
  expect(result).toEqual({ rejected: true, retried: true })
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Performance card 54")
  await expect(page.locator(".board .lead-card")).toHaveCount(1)
  await expect(page.getByRole("button", { name: "Open Performance card 54", exact: true })).toBeVisible()
})
