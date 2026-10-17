import { expect, test, type Page } from "./support/coverage"

async function createBlankWorkspace(page: Page, title: string) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill(title)

  await dialog.getByRole("button", { name: "Create" }).click()
}

test.describe("Datetime field type", () => {
  test("Given a board with a datetime field, supports datetime input, validation, card rendering, and persistence across reload", async ({ page }) => {
    await createBlankWorkspace(page, "Launch Tracker")

    // Configure a datetime field via Workspace Settings JSON
    await page.getByRole("button", { name: "Settings" }).click()
    const settingsDialog = page.getByRole("dialog", { name: "Settings" })
    await settingsDialog.getByRole("tab", { name: "Workspace", exact: true }).click()
    await settingsDialog.getByText("settings.json", { exact: true }).click()
    const editor = settingsDialog.getByLabel("Workspace settings JSON")
    const config = JSON.parse(await editor.inputValue())
    config.board.fields = [
      {
        title: "Target Launch",
        valueType: "datetime",
        required: true,
      },
    ]
    await editor.fill(JSON.stringify(config, null, 2))
    await settingsDialog.getByRole("button", { name: "Apply JSON" }).click()
    await expect(settingsDialog).toHaveCount(0)

    // Open Add Item dialog
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const itemDialog = page.getByRole("dialog", { name: "Item details" })
    await expect(itemDialog).toBeVisible()

    // Verify datetime-local input is rendered
    const datetimeInput = itemDialog.locator('input[type="datetime-local"]')
    await expect(datetimeInput).toBeVisible()

    // Test invalid state: required datetime field is left empty
    await itemDialog.getByLabel("Title *").fill("Production Deployment")
    await itemDialog.getByRole("button", { name: "Save item" }).click()
    await expect(itemDialog.getByRole("alert")).toContainText("Target Launch is required")

    // Enter valid datetime value
    await datetimeInput.fill("2026-09-15T14:30")

    // Save item
    await itemDialog.getByRole("button", { name: "Save item" }).click()
    await expect(itemDialog).toHaveCount(0)

    // Verify card rendered on board with title
    const card = page.locator(".lead-card", { hasText: "Production Deployment" })
    await expect(card).toBeVisible()

    // Open detail dialog and check field rendering
    await card.click()
    const detailDialog = page.getByRole("dialog", { name: "Item overview" })
    await expect(detailDialog).toBeVisible()
    await expect(detailDialog).toContainText("Target Launch")
    await expect(detailDialog).toContainText("2026-09-15T14:30")
    await detailDialog.getByRole("button", { name: "Dismiss" }).click()
    await expect(detailDialog).toHaveCount(0)

    // Verify filter input and card context rendering when filtered
    const fromFilter = page.getByLabel("Target Launch from")
    await expect(fromFilter).toBeVisible()
    await expect(fromFilter).toHaveAttribute("type", "datetime-local")
    await fromFilter.fill("2026-09-15T10:00")
    await expect(card).toContainText("Target Launch")
    await expect(card).toContainText("2026-09-15T14:30")

    // Verify persistence across page reload
    await page.reload()
    const reloadedCard = page.locator(".lead-card", { hasText: "Production Deployment" })
    await expect(reloadedCard).toBeVisible()

    // Open detail dialog and check persistence
    await reloadedCard.click()
    const reloadedDetail = page.getByRole("dialog", { name: "Item overview" })
    await expect(reloadedDetail).toBeVisible()
    await expect(reloadedDetail).toContainText("Target Launch")
    await expect(reloadedDetail).toContainText("2026-09-15T14:30")
    await reloadedDetail.getByRole("button", { name: "Dismiss" }).click()
  })

  test("Given schema visual editor, allows selecting datetime as field type", async ({ page }) => {
    await createBlankWorkspace(page, "Visual Schema Board")

    await page.getByRole("button", { name: "Edit board" }).click()
    await page.getByRole("button", { name: "Edit item" }).click()
    const schemaDialog = page.locator(".schema-editor-dialog")
    await expect(schemaDialog).toBeVisible()

    await schemaDialog.getByRole("button", { name: "+ Add field" }).click()
    await schemaDialog.getByLabel("Field name").fill("Scheduled At")
    await schemaDialog.getByLabel("Type").selectOption("datetime")
    await schemaDialog.getByRole("button", { name: "Save field" }).click()

    await expect(schemaDialog.getByText("Scheduled At")).toBeVisible()
    await expect(schemaDialog.locator(".field-type", { hasText: "datetime" })).toBeVisible()

    await schemaDialog.getByRole("button", { name: "Review changes" }).click()
    const previewDialog = page.getByRole("dialog", { name: "Preview schema changes" })
    await expect(previewDialog).toBeVisible()
    await expect(previewDialog).toContainText('Add field: "Scheduled At" (datetime)')
    await previewDialog.getByRole("button", { name: "Confirm apply" }).click()

    await page.getByRole("button", { name: "Done" }).click()

    // Verify the added field renders datetime-local input in item dialog
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const itemDialog = page.getByRole("dialog", { name: "Item details" })
    await expect(itemDialog.locator('input[type="datetime-local"]')).toBeVisible()
    await itemDialog.getByRole("button", { name: "Cancel" }).click()
  })
})
