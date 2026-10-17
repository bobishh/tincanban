import { expect, test, type Page } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

async function createLead(page: Page, company = "OpenProject") {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Editable leads")
  await page.getByRole("region", { name: "Lead" }).getByRole("button", { name: "Add lead to Lead" }).click()
  const form = page.getByRole("dialog", { name: "Add item" })
  await form.getByLabel("Company *").fill(company)
  await form.getByLabel("Role *").fill("Senior Ruby on Rails Developer")
  await form.getByLabel("Description", { exact: true }).fill("Already applied. ".repeat(60))
  await form.getByLabel("Work mode").selectOption({ label: "Remote" })
  await form.getByRole("button", { name: "Create item" }).click()
  await expect(form).toBeHidden()
  if (!await page.getByRole("dialog", { name: "Item overview" }).isVisible()) {
    await page.getByRole("button", { name: new RegExp(`Open ${company}`) }).click()
  }
}

test.describe("schema-driven lead editing", () => {
  test("Given a long lead, when details open and schema values change, then Edit stays visible and values survive reload", async ({ page }) => {
    await createLead(page)

    const detail = page.getByRole("dialog", { name: "Item overview" })
    const edit = detail.getByRole("button", { name: "Edit" })
    await expect(edit).toBeVisible()
    await expect(edit).toBeInViewport()
    await expect(detail).toHaveCSS("border-radius", "0px")
    await expect(detail).toHaveCSS("outline-style", "none")

    await edit.click()
    const form = page.getByRole("dialog", { name: "Edit item" })
    await expect(form.getByLabel("Company *")).toHaveValue("OpenProject")
    await expect(form.getByLabel("Role *")).toHaveValue("Senior Ruby on Rails Developer")
    await form.getByLabel("Company *").fill("OpenProject GmbH")
    await form.getByLabel("Location").fill("Remote / Berlin")
    await form.getByLabel("Work mode").selectOption({ label: "Hybrid" })
    await form.getByLabel("Description", { exact: true }).fill("Updated from the shared schema form")
    await form.getByRole("button", { name: "Save changes" }).click()

    await expect(form).toBeHidden()
    await expect(page.getByRole("dialog", { name: "Item overview" })).toContainText("OpenProject GmbH")
    await expect(page.getByRole("dialog", { name: "Item overview" })).toContainText("Updated from the shared schema form")

    await page.reload()
    await page.getByRole("button", { name: /Open OpenProject GmbH/ }).click()
    const reloaded = page.getByRole("dialog", { name: "Item overview" })
    await expect(reloaded).toContainText("Remote / Berlin")
    await expect(reloaded).toContainText(/hybrid/i)
  })

  test("Given storage failure, when lead edit saves, then the form stays open and retry commits atomically", async ({ page }) => {
    await createLead(page, "Failure Labs")
    await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Edit" }).click()
    const form = page.getByRole("dialog", { name: "Edit item" })
    await form.getByLabel("Company *").fill("Must Retry")

    await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
    await form.getByRole("button", { name: "Save changes" }).click()
    await expect(form).toBeVisible()
    await expect(form.getByRole("alert")).toBeVisible()
    await expect(page.getByRole("button", { name: /Open Must Retry/ })).toHaveCount(0)

    await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })
    await form.getByRole("button", { name: "Retry save" }).click()
    await expect(form).toBeHidden()
    await expect(page.getByRole("dialog", { name: "Item overview" })).toContainText("Must Retry")
  })
})
