import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function createBlankWorkspace(page: import("@playwright/test").Page, title: string) {
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill(title)
  await dialog.getByRole("radio", { name: "Blank board" }).check()
  await dialog.getByRole("button", { name: "Create" }).click()
}

test.describe("Visual board and entity editing", () => {
  test("Given a board, when edit mode renames and adds columns, then the board keeps those changes", async ({ page }) => {
    await page.goto("/")
    await createBlankWorkspace(page, "Engineering Sprint")

    await page.getByRole("button", { name: "Edit board" }).click()
    await page.getByRole("region", { name: "To do" }).getByRole("button", { name: "Edit column" }).click()
    const columnDialog = page.getByRole("dialog", { name: "Edit column" })
    await columnDialog.getByLabel("Column title").fill("Backlog")
    await columnDialog.getByRole("button", { name: "Save" }).click()
    await expect(page.getByRole("region", { name: "Backlog" })).toBeVisible()

    await page.getByRole("textbox", { name: "New column" }).fill("Review")
    await page.getByRole("button", { name: "+ Add column" }).click()
    await expect(page.getByRole("region", { name: "Review" })).toBeVisible()

    await page.getByRole("button", { name: "Done" }).click()
    await page.reload()
    await expect(page.getByRole("region", { name: "Backlog" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Review" })).toBeVisible()
  })

  test("Given entity editing, when its name is blank, then applying changes is blocked", async ({ page }) => {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await page.getByRole("button", { name: "Edit board" }).click()
    await page.getByRole("button", { name: "Edit lead" }).click()
    const editor = page.locator(".schema-editor-dialog")

    await editor.getByRole("textbox", { name: "Entity name" }).fill("")
    await expect(editor.getByText("/entityName")).toBeVisible()
    await expect(editor.getByRole("button", { name: "Review changes" })).toBeDisabled()
    await editor.getByRole("button", { name: "Dismiss" }).click()
  })

  test("Given a column with an item, when it is archived from visual edit mode, then its item is hidden", async ({ page }) => {
    await page.goto("/")
    await createBlankWorkspace(page, "Item Retention Board")

    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const itemForm = page.getByRole("dialog", { name: "Item details" })
    await itemForm.getByLabel("Title *").fill("Persistent Work Item")
    await itemForm.getByLabel("Status *").selectOption({ label: "Doing" })
    await itemForm.getByRole("button", { name: "Save item" }).click()
    await expect(page.getByText("Persistent Work Item")).toBeVisible()

    await page.getByRole("button", { name: "Edit board" }).click()
    await page.getByRole("region", { name: "Doing" }).getByRole("button", { name: "Edit column" }).click()
    const columnDialog = page.getByRole("dialog", { name: "Edit column" })
    await columnDialog.getByRole("button", { name: "Remove column" }).click()
    await expect(page.getByRole("region", { name: "Doing", includeHidden: true })).toHaveCount(1)
    await columnDialog.getByRole("button", { name: "Confirm removal", exact: true }).click()

    await expect(page.getByRole("region", { name: "Doing" })).toHaveCount(0)
    await expect(page.getByText("Persistent Work Item")).toHaveCount(0)
  })
})
