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

test("Given a recovery backup is generated, When restoration words or the next backup length change, Then generated words and their count remain unchanged", async ({ page }) => {
  await page.goto("/")
  await openSettings(page)
  await page.getByRole("button", { name: "Recovery backup", exact: true }).click()
  const recovery = page.getByRole("dialog", { name: "Identity recovery" })
  const download = page.waitForEvent("download")
  await recovery.getByRole("button", { name: "Generate and download recovery file" }).click()
  await download
  const generated = await recovery.locator(".recovery-words").textContent()
  await recovery.getByRole("combobox", { name: "Recovery length" }).selectOption("insane")
  await expect(recovery.getByText("Write down these 12 words now:", { exact: true })).toBeVisible()
  await recovery.getByRole("button", { name: "Restore from backup", exact: true }).click()
  await recovery.getByRole("textbox", { name: "Recovery words", exact: true }).fill("Different restoration words")
  await expect(recovery.getByRole("button", { name: "Restore identity", exact: true })).toBeDisabled()
  await recovery.getByRole("button", { name: "Create backup", exact: true }).click()
  await expect(recovery.locator(".recovery-words")).toHaveText(generated!)
})

test("Given Device sync, When Recovery opens, Then recovery controls stay visible without a technical device dump", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => { await (await import("/e2e/support/keeperDialog.ts")).mountSyncLayoutDialog() })
  const sync = page.getByRole("dialog", { name: "Device sync" })
  await sync.getByRole("tab", { name: "Recovery", exact: true }).click()
  await expect(sync.getByRole("region", { name: "Sync controls" })).toBeVisible()
  await expect(sync.getByText("Technical details", { exact: true })).toHaveCount(0)
  await expect(sync.locator(".mesh-device-ua")).toHaveCount(0)
  await sync.getByText("Ownership succession", { exact: true }).click()
  await expect(sync.getByRole("button", { name: "Enable editor quorum" })).toBeDisabled()
})


test("Given backup creation is pending or fails, When Export is selected, Then duplicate export is blocked and its error can be retried inline", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => {
    let attempts = 0
    await (await import("/e2e/support/keeperDialog.ts")).mountSyncLayoutDialog({ exportWorkspace: async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
      if (++attempts === 1) throw new Error("Backup storage unavailable")
    } })
  })
  const sync = page.getByRole("dialog", { name: "Device sync" })
  await sync.getByRole("tab", { name: "Backups", exact: true }).click()
  await sync.getByRole("button", { name: "Export .tincanban", exact: true }).click()
  await expect(sync.getByRole("button", { name: "Exporting…", exact: true })).toBeDisabled()
  await expect(sync.getByRole("alert")).toHaveText("Backup storage unavailable")
  await sync.getByRole("button", { name: "Retry export", exact: true }).click()
  await expect(sync.getByRole("button", { name: "Export .tincanban", exact: true })).toBeEnabled()
  await expect(sync.getByRole("alert")).toHaveCount(0)
})
