import { expect, test } from "./support/coverage"

test("Given storage failure, when an item is saved, then failure stays visible and no card publishes", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title").fill("Failure board")

  await create.getByRole("button", { name: "Create" }).click()
  await page.getByRole("button", { name: /Add item to/ }).first().click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Unsaved item")
  await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })

  await form.getByRole("button", { name: "Save item" }).click()

  await expect(form.getByRole("alert")).toContainText(/Storage failure|Save failed/i)
  await expect(page.locator(".save-state")).toHaveText("Not saved")
  await expect(page.getByRole("button", { name: "Open Unsaved item" })).toHaveCount(0)
})
