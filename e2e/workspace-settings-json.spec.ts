import { expect, test, type Page } from "./support/coverage"

async function createBlankWorkspace(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill("Configurable")
  await dialog.getByRole("radio", { name: "Blank board" }).check()
  await dialog.getByRole("button", { name: "Create" }).click()
}

test("Given a blank workspace, when invalid settings are repaired, then one apply persists all configuration", async ({ page }) => {
  await createBlankWorkspace(page)
  await page.getByRole("button", { name: "Settings" }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("tab", { name: "Workspace", exact: true }).click()
  await dialog.getByText("settings.json", { exact: true }).click()
  const editor = dialog.getByLabel("Workspace settings JSON")
  const config = JSON.parse(await editor.inputValue())
  const originalWorkspaceTitle = config.workspace.title

  await test.step("Reject empty entity name and keep committed board intact", async () => {
    config.board.entityName = ""
    await editor.fill(JSON.stringify(config, null, 2))
    await expect(dialog.getByText("/board/entityName")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Apply JSON" })).toBeDisabled()
    await expect(page.getByText(`TINCANBAN // ${originalWorkspaceTitle}`)).toBeVisible()
    config.board.entityName = "book"
  })

  await test.step("Reject a second archive column, then repair the draft", async () => {
    config.board.columns[0].title = "Cold storage"
    config.board.columns[0].archive = true
    config.board.columns[1].archive = true
    await editor.fill(JSON.stringify(config, null, 2))
    await expect(dialog.getByText("/board/columns/1/archive")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Apply JSON" })).toBeDisabled()
    delete config.board.columns[1].archive
  })

  await test.step("Apply repaired title, board, required field, template, and renamed archive", async () => {
    config.workspace.title = "Reading"
    config.board.columns[1].title = "Unread"
    config.board.fields = [{ title: "Author", valueType: "text", required: true }]
    config.documentTemplates = [{ title: "Review", markdown: "# {{title}}" }]
    await editor.fill(JSON.stringify(config, null, 2))
    await expect(dialog.getByRole("button", { name: "Apply JSON" })).toBeEnabled()
    await dialog.getByRole("button", { name: "Apply JSON" }).click()
    await expect(dialog).toBeHidden()

    await expect(page.getByText("TINCANBAN // Reading")).toBeVisible()
    await expect(page.getByRole("region", { name: "Cold storage", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "Add book to Unread" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Unread" }).getByText("No books", { exact: true })).toBeVisible()

    await page.getByRole("button", { name: "Add book to Unread" }).click()
    const item = page.getByRole("dialog", { name: "Item details" })
    await expect(item.getByLabel("Author *")).toBeVisible()
    await item.getByLabel("Title *").fill("The Left Hand of Darkness")
    await item.getByRole("button", { name: "Save item" }).click()
    await expect(item.getByRole("alert")).toContainText("Author is required")
    await item.getByLabel("Author *").fill("Ursula K. Le Guin")
    await item.getByRole("button", { name: "Save item" }).click()
    await expect(page.getByRole("button", { name: "Open The Left Hand of Darkness" })).toBeVisible()
  })

  await test.step("Reload and verify archive, field, and template in their UI", async () => {
    await page.reload()
    await expect(page.getByRole("region", { name: "Cold storage", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Open The Left Hand of Darkness" }).click()
    const persistedItem = page.getByRole("dialog", { name: "Item overview" })
    await expect(persistedItem.getByText("Ursula K. Le Guin", { exact: true })).toBeVisible()
    await persistedItem.getByRole("button", { name: "Dismiss" }).click()
    await page.getByRole("button", { name: "Settings" }).click()
    const savedSettings = page.getByRole("dialog", { name: "Settings" })
    await savedSettings.getByRole("tab", { name: "Workspace", exact: true }).click()
    await savedSettings.getByRole("tab", { name: "Document templates" }).click()
    await expect(savedSettings.getByRole("button", { name: "Review" })).toBeVisible()
    await savedSettings.getByRole("button", { name: "Review" }).click()
    await expect(savedSettings.getByRole("region", { name: "Template preview" })).toContainText("{{title}}")
    await savedSettings.getByRole("button", { name: "Dismiss" }).click()

    await page.getByRole("button", { name: "Add book to Unread" }).click()
    const reopened = page.getByRole("dialog", { name: "Item details" })
    await expect(reopened.getByLabel("Author *")).toBeVisible()
    await expect(reopened.getByLabel("Title *")).toHaveValue("")
  })
})
