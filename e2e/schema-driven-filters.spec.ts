import { expect, test, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function openSettingsJson(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("tab", { name: "Workspace", exact: true }).click()
  await dialog.getByText("settings.json", { exact: true }).click()
  return { dialog, editor: dialog.getByLabel("Workspace settings JSON") }
}

test.describe("Schema-driven board filters", () => {
  test("Given a renamed select option, when filters render, then they use the current schema title and stable option ID", async ({ page }) => {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    const { dialog, editor } = await openSettingsJson(page)
    const settings = JSON.parse(await editor.inputValue())
    const priority = settings.board.fields.find((field: any) => field.title === "Priority")
    const optionId = priority.options[0].id
    priority.options[0].title = "Now"
    await editor.fill(JSON.stringify(settings, null, 2))
    await dialog.getByRole("button", { name: "Apply JSON" }).click()

    const priorityFilter = page.getByRole("group", { name: "Filters" }).getByLabel("Priority")
    await expect(priorityFilter.getByRole("option", { name: "Now" })).toHaveAttribute("value", optionId)
    await expect(priorityFilter.getByRole("option", { name: /P0 · now/ })).toHaveCount(0)
  })

  test("Given a generic workspace select field, when one option is filtered, then only matching items remain", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const create = page.getByRole("dialog", { name: "Create workspace" })
    await create.getByLabel("Title").fill("Reading filters")
    await create.getByRole("radio", { name: "Blank board" }).check()
    await create.getByRole("button", { name: "Create" }).click()

    const { dialog, editor } = await openSettingsJson(page)
    const settings = JSON.parse(await editor.inputValue())
    settings.board.fields.push({
      title: "Genre",
      valueType: "select",
      required: false,
      options: [{ title: "Sci-fi" }, { title: "Essay" }],
    })
    await editor.fill(JSON.stringify(settings, null, 2))
    await dialog.getByRole("button", { name: "Apply JSON" }).click()

    for (const [title, genre] of [["Dune", "Sci-fi"], ["Ways of Seeing", "Essay"]]) {
      await page.getByRole("region", { name: "To do" }).getByRole("button", { name: "Add item to To do" }).click()
      const form = page.getByRole("dialog", { name: "Item details" })
      await form.getByLabel("Title *").fill(title)
      await form.getByLabel("Genre").selectOption({ label: genre })
      await form.getByRole("button", { name: "Save item" }).click()
    }

    await page.getByRole("group", { name: "Filters" }).getByLabel("Genre").selectOption({ label: "Sci-fi" })
    await expect(page.getByText("Dune")).toBeVisible()
    await expect(page.getByText("Ways of Seeing")).toHaveCount(0)
  })

  test("Given a numeric schema field, when filters render, then bounds come from the schema without preset buckets", async ({ page }) => {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    const filters = page.getByRole("group", { name: "Filters" })
    await expect(filters.getByLabel("Fit score minimum")).toHaveAttribute("min", "0")
    await expect(filters.getByLabel("Fit score maximum")).toHaveAttribute("max", "10")
    await expect(filters.getByRole("option", { name: "8–10" })).toHaveCount(0)
  })
})
