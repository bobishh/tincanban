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
