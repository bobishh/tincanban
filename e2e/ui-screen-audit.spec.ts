import { expect, test } from "./support/coverage"

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "webkit") await page.setViewportSize({ width: 390, height: 844 })
})

async function openSettings(page: import("@playwright/test").Page) {
  if ((page.viewportSize()?.width ?? 1440) < 720) await page.getByRole("button", { name: "Menu", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
}

test("Given the board directory, When an invalid backup is selected, Then import failure stays beside the import action and the current board remains", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
  const workspaces = page.getByRole("dialog", { name: "Workspaces", exact: true })
  const chooser = page.waitForEvent("filechooser")
  await workspaces.getByRole("button", { name: "Import as new board", exact: true }).click()
  await (await chooser).setFiles({ name: "invalid.tincanban", mimeType: "application/vnd.tincanban+zip", buffer: Buffer.from("not a backup") })
  await expect(workspaces.getByRole("alert")).toBeVisible()
  await expect(workspaces.getByRole("button", { name: "Import as new board", exact: true })).toBeEnabled()
  await workspaces.getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
})

test("Given an unsaved template, When settings tabs change and Save is repeated, Then its draft survives and only one template is stored", async ({ page }) => {
  await page.goto("/")
  await openSettings(page)
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Document templates", exact: true }).click()
  await settings.getByLabel("Name", { exact: true }).fill("Audit template")
  await settings.getByLabel("Markdown", { exact: true }).fill("# Saved draft")
  await settings.getByRole("tab", { name: "settings.json", exact: true }).click()
  await settings.getByRole("tab", { name: "Identity", exact: true }).click()
  await settings.getByRole("tab", { name: "Document templates", exact: true }).click()
  await expect(settings.getByLabel("Markdown", { exact: true })).toHaveValue("# Saved draft")
  await settings.getByRole("button", { name: "Save template", exact: true }).click()
  await expect(settings.getByRole("status", { name: "Template save status" })).toContainText("Saved")
  await settings.getByLabel("Markdown", { exact: true }).fill("# Updated draft")
  await settings.getByRole("button", { name: "Save template", exact: true }).click()
  await expect(settings.getByRole("status", { name: "Template save status" })).toContainText("Saved")
  const saved = await page.evaluate(async () => (await import("/src/test/stateFixture.ts")).useTincanban().workspace.templates.filter(template => template.name === "Audit template").map(template => template.markdown))
  expect(saved).toEqual(["# Updated draft"])
})

test("Given template storage fails, When Save is retried, Then the error and draft stay in the editor and a single template is saved", async ({ page }) => {
  await page.goto("/")
  await openSettings(page)
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Document templates", exact: true }).click()
  await settings.getByLabel("Name", { exact: true }).fill("Retry template")
  await settings.getByLabel("Markdown", { exact: true }).fill("Keep this draft")
  await page.evaluate(async () => (await import("/src/storage.ts")).setStorageFailureHookForTest(true))
  await settings.getByRole("button", { name: "Save template", exact: true }).click()
  await expect(settings.getByRole("alert")).toBeVisible()
  await settings.getByRole("tab", { name: "Identity", exact: true }).click()
  await settings.getByRole("tab", { name: "Document templates", exact: true }).click()
  await expect(settings.getByRole("alert")).toBeVisible()
  await expect(settings.getByLabel("Markdown", { exact: true })).toHaveValue("Keep this draft")
  await page.evaluate(async () => (await import("/src/storage.ts")).setStorageFailureHookForTest(false))
  await settings.getByRole("button", { name: "Retry save", exact: true }).click()
  await expect(settings.getByRole("status", { name: "Template save status" })).toContainText("Saved")
  await expect(settings.locator(".template-item").filter({ hasText: "Retry template" })).toHaveCount(1)
})

test("Given Identity settings is open, When its controls render, Then generic recovery backup stays out of the profile flow", async ({ page }) => {
  await page.goto("/")
  await openSettings(page)
  await expect(page.getByRole("region", { name: "Identity recovery" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Recovery backup", exact: true })).toHaveCount(0)
})

test("Given Device sync, When participants open, Then succession actions stay beside participants without a technical device dump", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => { await (await import("/e2e/support/keeperDialog.ts")).mountSyncLayoutDialog() })
  const sync = page.getByRole("dialog", { name: "Device sync" })

  await expect(sync.getByRole("button", { name: "Leave mesh", exact: true })).toBeVisible()
  await expect(sync.getByText("Technical details", { exact: true })).toHaveCount(0)
  await expect(sync.locator(".mesh-device-ua")).toHaveCount(0)

  await expect(sync.getByRole("button", { name: "Enable editor quorum" })).toBeDisabled()
})


test("Given backup creation is pending or fails, When Export is selected, Then duplicate export is blocked and its error can be retried inline", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => {
    let attempts = 0
    await (await import("/e2e/support/keeperDialog.ts")).mountWorkspaceFileActions(async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
      if (++attempts === 1) throw new Error("Backup storage unavailable")
    })
  })
  const sync = page.getByRole("region", { name: "Workspace files", exact: true })
  const exportButton = sync.locator(".sync-data-actions > button").nth(0)
  await exportButton.click()
  await expect(exportButton).toHaveText("Exporting…")
  await expect(exportButton).toBeDisabled()
  await expect(sync.getByRole("alert")).toHaveText("Backup storage unavailable")
  await sync.getByRole("button", { name: "Retry export", exact: true }).click()
  await expect(sync.getByRole("button", { name: "Export .tincanban", exact: true })).toBeEnabled()
  await expect(sync.getByRole("alert")).toHaveCount(0)
})

test("Given all-board export is pending and fails, When retried, Then progress and failure stay visible without losing the retry", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => {
    let attempts = 0
    let releaseFirstAttempt!: () => void
    const firstAttemptGate = new Promise<void>(resolve => { releaseFirstAttempt = resolve })
    await (await import("/e2e/support/keeperDialog.ts")).mountWorkspaceFileActions(async () => undefined, async onProgress => {
      onProgress({ completed: 1, total: 2 })
      if (++attempts === 1) {
        await firstAttemptGate
        throw new Error("The second board could not be read")
      }
      onProgress({ completed: 2, total: 2 })
    })
    Object.assign(window, { releaseFirstAllBoardExport: () => releaseFirstAttempt() })
  })
  const sync = page.getByRole("region", { name: "Workspace files", exact: true })
  const exportAllButton = sync.locator(".sync-data-actions > button").nth(1)
  await exportAllButton.click()
  await expect(exportAllButton).toHaveText("Exporting boards…")
  await expect(exportAllButton).toBeDisabled()
  await expect(sync.locator("[role='status']")).toContainText("Exporting board 1 of 2")
  await expect(sync.getByRole("alert")).toHaveCount(0)
  await page.evaluate(() => {
    const release = (window as Window & { releaseFirstAllBoardExport?: () => void }).releaseFirstAllBoardExport
    if (!release) throw new Error("The pending export gate was not installed")
    release()
  })
  await expect(sync.getByRole("alert")).toHaveText("The second board could not be read")
  await sync.getByRole("button", { name: "Retry all-board export", exact: true }).click()
  await expect(sync.getByRole("button", { name: "Export all boards", exact: true })).toBeEnabled()
  await expect(sync.getByRole("alert")).toHaveCount(0)
})
