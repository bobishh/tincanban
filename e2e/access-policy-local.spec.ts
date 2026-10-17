import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

type AccessRefreshProbe = Window & { __TINCANBAN_ACCESS_REFRESH__?: { inactiveLoads: number; pending: number; lastStack?: string } }

test("Given multiple workspaces, when active content changes, then inactive access loads wait for workspace invalidation", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.evaluate(async () => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const firstId = state.activeWorkspace.id
    await state.createWorkspaceAsync("Access refresh probe", "blank")
    await state.switchWorkspace(firstId)
  })
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.evaluate(async () => {
    const tincanban = (await import("/src/test/stateFixture.ts")).useTincanban()
    const storage = (await import("/src/storage.ts")).defaultStorage
    const probeId = tincanban.availableWorkspaces.value.find(item => item.title === "Access refresh probe")!.id
    const original = storage.loadWorkspaceDoc.bind(storage)
    const probeWindow = window as AccessRefreshProbe
    probeWindow.__TINCANBAN_ACCESS_REFRESH__ = { inactiveLoads: 0, pending: 0 }
    storage.loadWorkspaceDoc = async (...args: Parameters<typeof original>) => {
      const accessCheck = args[0] === probeId && new Error().stack?.includes("getWorkspaceRole")
      if (accessCheck) {
        probeWindow.__TINCANBAN_ACCESS_REFRESH__!.inactiveLoads++
        probeWindow.__TINCANBAN_ACCESS_REFRESH__!.pending++
        probeWindow.__TINCANBAN_ACCESS_REFRESH__!.lastStack = new Error().stack
      }
      try { return await original(...args) }
      finally { if (accessCheck) probeWindow.__TINCANBAN_ACCESS_REFRESH__!.pending-- }
    }
  })
  await expect.poll(() => page.evaluate(() => (window as AccessRefreshProbe).__TINCANBAN_ACCESS_REFRESH__!.pending)).toBe(0)
  await page.waitForTimeout(150)
  await page.evaluate(() => { (window as AccessRefreshProbe).__TINCANBAN_ACCESS_REFRESH__!.inactiveLoads = 0 })

  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill("Content refresh probe")
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await expect(page.getByRole("heading", { name: "Content refresh probe" })).toBeVisible()
  await page.waitForTimeout(150)
  await expect.poll(() => page.evaluate(() => (window as AccessRefreshProbe).__TINCANBAN_ACCESS_REFRESH__!.pending)).toBe(0)
  const inactiveLoads = await page.evaluate(() => (window as AccessRefreshProbe).__TINCANBAN_ACCESS_REFRESH__!)
  expect(inactiveLoads.inactiveLoads, inactiveLoads.lastStack).toBe(0)

  await page.getByRole("button", { name: "Close detail" }).click()
  await page.getByRole("button", { name: "Open workspaces" }).click()
  const workspaces = page.getByRole("dialog", { name: "Workspaces" })
  await workspaces.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Catalog refresh probe")

  await create.getByRole("button", { name: "Create", exact: true }).click()
  await expect(create).toBeHidden()
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as AccessRefreshProbe).__TINCANBAN_ACCESS_REFRESH__!.inactiveLoads)).toBeGreaterThan(0)
})
