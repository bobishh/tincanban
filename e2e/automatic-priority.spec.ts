import { expect, test, type Page } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

async function openPriorityRules(page: Page) {
  await page.getByRole("button", { name: "Settings" }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("tab", { name: "Workspace", exact: true }).click()
  await dialog.getByRole("tab", { name: "Priority rules" }).click()
  return dialog
}

async function addLead(page: Page, company: string, workMode: "remote" | "onsite", assessment?: object) {
  await page.getByRole("region", { name: "Lead" }).getByRole("button", { name: "Add lead to Lead" }).click()
  const dialog = page.getByRole("dialog", { name: "Add item" })
  await expect(dialog.getByLabel("Priority")).toHaveCount(0)
  await expect(dialog.getByLabel("Fit score")).toHaveCount(0)
  await expect(dialog.getByText("Values are calculated from configured rules.")).toBeVisible()
  await dialog.getByLabel("Company *").fill(company)
  await dialog.getByLabel("Role *").fill("Backend Engineer")
  await dialog.getByLabel("Work mode").selectOption({ label: workMode === "remote" ? "Remote" : "Onsite" })
  if (assessment) await dialog.getByLabel("Source text").fill(JSON.stringify({ decision: { assessment } }))
  await dialog.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Close detail" }).click()
}

test.describe("Automatic priority from workspace preferences", () => {
  test("Given weighted work-mode rules, when leads are created, then fit and priority are derived without manual fields", async ({ page }) => {
    await page.goto("/")
    await createJobSearchWorkspace(page, "Weighted jobs")

    const settings = await openPriorityRules(page)
    await settings.getByRole("switch", { name: "Automatic priority", exact: true }).check()
    await settings.getByText("settings.json", { exact: true }).click()
    const json = settings.getByLabel("Workspace settings JSON")
    const draft = JSON.parse(await json.inputValue())
    const mode = draft.board.fields.find((field: { title: string }) => field.title === "Work mode")
    const priority = draft.board.fields.find((field: { title: string }) => field.title === "Priority")
    const fit = draft.board.fields.find((field: { title: string }) => field.title === "Fit score")
    draft.board.priorityPolicy = { version: 1, evaluator: "weighted-rules-v1", sort: "fit_desc", priorityFieldId: priority.id, fitFieldId: fit.id,
      rules: [], bands: priority.options.map((option: { id: string; title: string }) => ({ optionId: option.id,
        minScore: ({ P0: 8, P1: 6, P2: 3, P3: 0 } as Record<string, number>)[option.title] })) }
    delete draft.board.priorityPolicy.assessmentFieldId
    draft.board.priorityPolicy.rules = mode.options.map((option: { id: string; title: string }) => ({
      id: option.id, fieldId: mode.id, operator: "equals", value: option.id,
      weight: option.title === "Remote" ? 8 : option.title === "Hybrid" ? 5 : option.title === "Unknown" ? 2 : 0,
    }))
    await json.fill(JSON.stringify(draft))
    await settings.getByRole("tab", { name: "Priority rules" }).click()
    await settings.getByRole("switch", { name: "Automatic priority", exact: true }).uncheck()
    await settings.getByRole("switch", { name: "Automatic priority", exact: true }).check()
    await expect(settings.getByRole("group", { name: "Weighted criteria" })).toContainText("Work mode")
    await expect(settings.getByLabel("Card order")).toHaveValue("fit_desc")
    await settings.getByRole("button", { name: "Save priority rules" }).click()

    await addLead(page, "Office only", "onsite")
    await addLead(page, "Remote first", "remote")

    const remote = page.locator(".lead-card").filter({ has: page.getByRole("button", { name: "Open Remote first — Backend Engineer" }) })
    await expect(remote).toContainText("P0")
    await expect(remote).toContainText("Fit score8")
    await remote.getByRole("button", { name: "Open Remote first — Backend Engineer", exact: true }).click()
    const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
    await expect(detail.locator(".configured-card-field").filter({ hasText: "Priority" })).toContainText("P0")
    await expect(detail.locator(".configured-card-field").filter({ hasText: "Fit score" })).toContainText("8")
    await detail.getByRole("button", { name: "Close detail", exact: true }).click()
    const onsite = page.locator(".lead-card").filter({ has: page.getByRole("button", { name: "Open Office only — Backend Engineer" }) })
    await expect(onsite).toContainText("P3")
    await expect(onsite).toContainText("Fit score0")
    const cards = page.getByRole("region", { name: "Lead" }).locator(".lead-card")
    await expect(cards.first().getByRole("button", { name: "Open Remote first — Backend Engineer", exact: true })).toBeVisible()

    const reopened = await openPriorityRules(page)
    await reopened.getByLabel("Card order").selectOption("fit_asc")
    await reopened.getByRole("button", { name: "Save priority rules" }).click()
    await expect(cards.first().getByRole("button", { name: "Open Office only — Backend Engineer", exact: true })).toBeVisible()
  })

  test("Given automatic priority with no criteria, when saving, then settings stay open with an actionable error", async ({ page }) => {
    await page.goto("/")
    await createJobSearchWorkspace(page, "Broken rules")

    const settings = await openPriorityRules(page)
    await settings.getByRole("switch", { name: "Automatic priority", exact: true }).check()
    await settings.getByText("settings.json", { exact: true }).click()
    const json = settings.getByLabel("Workspace settings JSON")
    const draft = JSON.parse(await json.inputValue())
    const mode = draft.board.fields.find((field: { title: string }) => field.title === "Work mode")
    const priority = draft.board.fields.find((field: { title: string }) => field.title === "Priority")
    const fit = draft.board.fields.find((field: { title: string }) => field.title === "Fit score")
    draft.board.priorityPolicy = { version: 1, evaluator: "weighted-rules-v1", sort: "fit_desc", priorityFieldId: priority.id, fitFieldId: fit.id,
      rules: [], bands: priority.options.map((option: { id: string; title: string }) => ({ optionId: option.id,
        minScore: ({ P0: 8, P1: 6, P2: 3, P3: 0 } as Record<string, number>)[option.title] })) }
    delete draft.board.priorityPolicy.assessmentFieldId
    draft.board.priorityPolicy.rules = mode.options.map((option: { id: string; title: string }) => ({
      id: option.id, fieldId: mode.id, operator: "equals", value: option.id,
      weight: option.title === "Remote" ? 8 : option.title === "Hybrid" ? 5 : option.title === "Unknown" ? 2 : 0,
    }))
    await json.fill(JSON.stringify(draft))
    await settings.getByRole("tab", { name: "Priority rules" }).click()
    const removeRules = settings.getByRole("button", { name: /Remove .* rule/ })
    while (await removeRules.count()) await removeRules.first().click()
    await settings.getByRole("button", { name: "Save priority rules" }).click()

    await expect(settings.getByRole("alert")).toHaveText("Add at least one priority rule")
    await expect(settings).toBeVisible()
  })
})

test("Given a configured priority draft, when persistence fails, then retain rules and retry the same configuration", async ({ page }) => {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Retry rules")
  const settings = await openPriorityRules(page)
  await settings.getByRole("switch", { name: "Automatic priority", exact: true }).check()
  await settings.getByText("settings.json", { exact: true }).click()
  const json = settings.getByLabel("Workspace settings JSON")
  const draft = JSON.parse(await json.inputValue())
  const priority = draft.board.fields.find((field: { title: string }) => field.title === "Priority")
  const fit = draft.board.fields.find((field: { title: string }) => field.title === "Fit score")
  const source = draft.board.fields.find((field: { title: string }) => field.title === "Source text")
  draft.board.priorityPolicy = { version: 1, evaluator: "weighted-rules-v1", sort: "manual", priorityFieldId: priority.id, fitFieldId: fit.id,
    rules: [{ id: "source-present", fieldId: source.id, operator: "is_set", value: null, weight: 2 }],
    bands: [{ optionId: priority.options[0].id, minScore: 0 }] }
  await json.fill(JSON.stringify(draft))
  await settings.getByRole("tab", { name: "Priority rules" }).click()
  await page.evaluate(() => { (window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
  await settings.getByRole("button", { name: "Save priority rules" }).click()
  await expect(settings.getByRole("alert")).toContainText("Storage failure injected")
  await expect(settings.getByRole("group", { name: "Weighted criteria" })).toContainText("Source text")
  await page.evaluate(() => { (window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })
  await settings.getByRole("button", { name: "Save priority rules" }).click()
  await expect(settings).toBeHidden()
  await page.reload()
  const reopened = await openPriorityRules(page)
  await expect(reopened.getByRole("group", { name: "Weighted criteria" })).toContainText("Source text")
  await expect(reopened.getByRole("group", { name: "Job match criteria" })).toHaveCount(0)
  await expect(reopened.getByLabel("Employee stack")).toHaveCount(0)
})
