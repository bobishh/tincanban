import { expect, test } from "./support/coverage"

type StorageFailureWindow = Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }

async function createBlankBoard(page: import("@playwright/test").Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill("Archive option")

  await dialog.getByRole("button", { name: "Create" }).click()
}

test("Given a blank board, when Archive column is enabled and item archived, then one collapsible Archive contains item after reload", async ({ page }) => {
  await createBlankBoard(page)
  await page.getByRole("button", { name: "Edit board" }).click()
  const archiveOption = page.getByRole("checkbox", { name: "Archive column" })
  await expect(archiveOption).toBeEnabled()
  await archiveOption.check()
  await page.getByRole("checkbox", { name: "Allow this column to collapse" }).check()
  await expect(page.getByRole("textbox", { name: "New column" })).toHaveValue("Archive")
  await page.getByRole("button", { name: "+ Add column" }).click()
  await expect(archiveOption).toBeDisabled()
  await page.locator(".topbar").getByRole("button", { name: "Done", exact: true }).click()

  await page.getByRole("button", { name: "Add item to To do" }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Keep this card")
  await form.getByRole("button", { name: "Save item" }).click()
  await page.getByRole("button", { name: "Open Keep this card" }).click()
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Archive item" }).click()

  await expect(page.getByRole("region", { name: "To do" }).getByRole("button", { name: "Open Keep this card" })).toHaveCount(0)
  await page.getByRole("button", { name: "Open Archive with 1 cards" }).click()
  await expect(page.getByRole("region", { name: "Archive" }).getByRole("button", { name: "Open Keep this card" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("region", { name: "Archive" }).getByRole("button", { name: "Open Keep this card" })).toBeVisible()
})

test("Given archive column save fails, when checked column is added, then draft remains and board has no Archive", async ({ page }) => {
  await createBlankBoard(page)
  await page.getByRole("button", { name: "Edit board" }).click()
  await page.evaluate(() => { (window as StorageFailureWindow).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
  await page.getByRole("checkbox", { name: "Archive column" }).check()
  await page.getByRole("button", { name: "+ Add column" }).click()
  await expect(page.getByRole("checkbox", { name: "Archive column" })).toBeChecked()
  await expect(page.getByRole("textbox", { name: "New column" })).toHaveValue("Archive")
  await expect(page.getByRole("region", { name: "Archive", exact: true })).toHaveCount(0)
  await expect(page.getByRole("alert")).toContainText("Storage failure injected")
})

test("Given item archived before Archive column exists, when column is enabled, then item appears and restores", async ({ page }) => {
  await createBlankBoard(page)
  await page.getByRole("button", { name: "Add item to To do" }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Earlier card")
  await form.getByRole("button", { name: "Save item" }).click()
  await page.getByRole("button", { name: "Open Earlier card" }).click()
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Archive item" }).click()

  await page.getByRole("button", { name: "Edit board" }).click()
  await page.getByRole("checkbox", { name: "Archive column" }).check()
  await page.getByRole("checkbox", { name: "Allow this column to collapse" }).check()
  await page.getByRole("button", { name: "+ Add column" }).click()
  await page.locator(".topbar").getByRole("button", { name: "Done", exact: true }).click()
  await page.getByRole("button", { name: "Open Archive with 1 cards" }).click()
  await page.getByRole("region", { name: "Archive", exact: true }).getByRole("button", { name: "Open Earlier card" }).click()
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Restore item" }).click()
  await expect(page.getByRole("region", { name: "To do" }).getByRole("button", { name: "Open Earlier card" })).toBeVisible()
  await expect(page.getByRole("region", { name: "Archive", exact: true }).getByRole("button", { name: "Open Earlier card" })).toHaveCount(0)
})
