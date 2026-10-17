import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test.describe("Column add actions and overlay notices", () => {
  test("Given a job board, when adding from Applied, then the form starts in Applied and no add action occupies the header", async ({ page }) => {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)

    const header = page.locator(".topbar")
    await expect(header.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)

    const applied = page.getByRole("region", { name: "Applied" })
    await applied.getByRole("button", { name: "Add lead to Applied" }).click()
    const form = page.getByRole("dialog", { name: "Add item" })
    await expect(form.getByLabel("Status")).toHaveValue((await applied.getAttribute("data-column-id"))!)
  })

  test("Given a successful action, when its notice appears, then it overlays content and disappears", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await dialog.getByLabel("Title").fill("Notice board")

    await dialog.getByRole("button", { name: "Create" }).click()

    const notice = page.getByRole("status").filter({ hasText: "Workspace \"Notice board\" created" })
    await expect(notice).toBeVisible()
    await expect(page.locator(".notice-overlay")).toHaveCSS("position", "fixed")
    await expect(notice).toBeHidden({ timeout: 6_000 })
  })

  test("Given a blank board, when adding inside Doing, then the item form is scoped to Doing", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await dialog.getByLabel("Title").fill("Column add board")

    await dialog.getByRole("button", { name: "Create" }).click()

    const doing = page.getByRole("region", { name: "Doing" })
    await doing.getByRole("button", { name: "Add item to Doing" }).click()
    await expect(page.getByRole("dialog", { name: "Item details" }).getByLabel("Status *")).toHaveValue(/.+/)
    await expect(page.getByRole("dialog", { name: "Item details" }).getByLabel("Status *").locator("option:checked")).toHaveText("Doing")
  })
})
