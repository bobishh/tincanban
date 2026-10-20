import { expect, test, type Locator, type Page } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

async function openItem(page: Page, title: string) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const workspace = page.getByRole("dialog", { name: "Create workspace" })
  await workspace.getByLabel("Title", { exact: true }).fill("Quick notes")
  await workspace.getByRole("button", { name: "Create", exact: true }).click()
  await expect(workspace).toBeHidden()
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  await form.getByLabel("Title *", { exact: true }).fill(title)
  await form.getByRole("button", { name: "Save item", exact: true }).click()
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click()
}

async function expandQuickNote(detail: Locator) {
  await detail.locator("summary").filter({ hasText: /^Quick note$/ }).click()
}

test("Given an item overview, when a quick note is typed and added, then focus stays in the input and the note survives reload", async ({ page }, testInfo) => {
  await openItem(page, "Remember this")
  const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
  await expect(detail.getByRole("textbox", { name: "Quick note", exact: true })).toBeHidden()
  await expandQuickNote(detail)
  const input = detail.getByRole("textbox", { name: "Quick note", exact: true })
  await input.click()
  await expect(input).toBeFocused()
  await input.pressSequentially("Call Alice after lunch", { delay: 20 })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("Call Alice after lunch")
  await detail.getByRole("button", { name: "Add note", exact: true }).click()

  await expect(detail.getByText("Call Alice after lunch", { exact: true })).toBeVisible()
  await expect(detail.getByRole("textbox", { name: "Quick note", exact: true })).toHaveValue("")
  await detail.screenshot({ path: testInfo.outputPath("quick-note-saved-without-item-label.png") })
  await page.reload()
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Call Alice after lunch")
  await expect(page.getByRole("button", { name: "Open Remember this", exact: true })).toBeVisible()
  await page.getByRole("searchbox", { name: "Search cards" }).fill("")
  await page.getByRole("button", { name: "Open Remember this", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Item overview", exact: true })
    .getByText("Call Alice after lunch", { exact: true })).toBeVisible()
})

test("Given quick-note persistence fails, when retry succeeds, then the draft stays and one note is saved", async ({ page }) => {
  await openItem(page, "Retry note")
  const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
  await expandQuickNote(detail)
  const draft = detail.getByRole("textbox", { name: "Quick note", exact: true })
  await draft.fill("Do not lose this draft")
  await page.evaluate(() => { (window as unknown as { __TINCANBAN_INJECT_STORAGE_FAILURE__: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })

  await detail.getByRole("button", { name: "Add note", exact: true }).click()

  await expect(detail.getByRole("alert")).toContainText("Note not saved")
  await expect(draft).toHaveValue("Do not lose this draft")
  await expandQuickNote(detail)
  await expandQuickNote(detail)
  await expect(draft).toHaveValue("Do not lose this draft")
  await expect(detail.getByText("Do not lose this draft", { exact: true })).toHaveCount(0)
  await page.evaluate(() => { (window as unknown as { __TINCANBAN_INJECT_STORAGE_FAILURE__: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })
  await detail.getByRole("button", { name: "Retry note", exact: true }).click()
  await expect(detail.getByText("Do not lose this draft", { exact: true })).toHaveCount(1)
})

test("Given a Job search lead, when a quick note is added, then it appends to its Description", async ({ page }) => {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Quick lead notes")
  await page.getByRole("region", { name: "Lead" }).getByRole("button", { name: "Add lead to Lead" }).click()
  const form = page.getByRole("dialog", { name: "Add item", exact: true })
  await form.getByLabel("Company *", { exact: true }).fill("Quick Note Corp")
  await form.getByLabel("Role *", { exact: true }).fill("Engineer")
  await form.getByLabel("Description", { exact: true }).fill("Existing context")
  await form.getByRole("button", { name: "Create item", exact: true }).click()
  const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
  await expect(detail).toBeVisible()
  await expandQuickNote(detail)
  await detail.getByRole("textbox", { name: "Quick note", exact: true }).fill("Follow up Friday")
  await detail.getByRole("button", { name: "Add note", exact: true }).click()

  await expect(detail.getByText("Existing context\n\nFollow up Friday", { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "Open Quick Note Corp — Engineer", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Item overview", exact: true })
    .getByText("Existing context\n\nFollow up Friday", { exact: true })).toBeVisible()
})
