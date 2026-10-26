import { expect, test, type Page } from "./support/coverage"

async function createBlankWorkspace(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill("Configurable")

  await dialog.getByRole("button", { name: "Create" }).click()
}

async function importLegacyPriorityWorkspace(page: Page) {
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  const fixture = await page.evaluate(async () => {
    const { createWorkspaceDoc } = await import("/src/test/boardFixture.ts")
    const { createDefaultPriorityPolicy } = await import("/src/domain/priority.ts")
    const { exportWorkspaceBundleV2 } = await import("/src/domain/workspaceBundle.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const doc = createWorkspaceDoc("legacy-priority", "Legacy jobs", "fixture-owner", "job-search")
    const board = Object.values(doc.entities).find(entity => entity.kind === "board")
    if (!board || board.kind !== "board" || !board.preset) throw new Error("job-search board fixture unavailable")
    const fields = Object.values(doc.entities).filter(entity => entity.kind === "field")
    const policy = createDefaultPriorityPolicy(board, fields)
    if (!policy) throw new Error("job-search priority fields unavailable")
    const legacyPolicy = { ...policy, evaluator: "job-fit-v1" }
    const automation = board.automation
    if (!automation) throw new Error("job-search automation fixture unavailable")
    board.priorityPolicy = legacyPolicy
    delete board.automation

    const bindings = board.preset.bindings
    const priorityField = doc.entities[bindings["field.priority"]]
    if (!priorityField || priorityField.kind !== "field" || priorityField.valueType !== "select") throw new Error("priority field unavailable")
    const p1 = Object.values(priorityField.options).find(option => option.title === "P1")
    if (!p1) throw new Error("P1 option unavailable")
    const now = "2026-01-01T00:00:00.000Z"
    doc.entities["legacy-card"] = {
      id: "legacy-card", title: "Example Co — Backend Engineer", body: "Existing card description",
      values: {
        [bindings["field.company"]]: "Example Co",
        [bindings["field.role"]]: "Backend Engineer",
        [bindings["field.priority"]]: p1.id,
        [bindings["field.sourceText"]]: "Retained source text",
      },
      placement: { parentId: bindings["status.lead"], rank: "0/1" },
      archivedAt: null, createdAt: now, updatedAt: now,
    }
    const bundle = await exportWorkspaceBundleV2(A.from(doc))
    return { bundle: Array.from(bundle), policy: legacyPolicy, automation }
  })
  await page.locator('input[type="file"][accept*=".tincanban"]').setInputFiles({
    name: "legacy-priority.tincanban", mimeType: "application/vnd.tincanban+zip", buffer: Buffer.from(fixture.bundle),
  })
  await expect(page.getByRole("button", { name: /Open Example Co — Backend Engineer/ })).toBeVisible()
  return fixture
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

test("Given an imported inert priority policy, when automation is added in settings JSON, then policy and card values survive apply and reload", async ({ page }) => {
  await page.goto("/")
  const fixture = await importLegacyPriorityWorkspace(page)
  const openCard = page.getByRole("button", { name: /Open Example Co — Backend Engineer/ })
  await openCard.click()
  const card = page.getByRole("dialog", { name: "Item overview" })
  await expect(card.getByText("Retained source text", { exact: true })).toBeVisible()
  await card.getByRole("button", { name: "Close detail" }).click()

  await page.getByRole("button", { name: "Settings" }).click()
  const dialog = page.getByRole("dialog", { name: "Settings" })
  await dialog.getByRole("tab", { name: "Workspace", exact: true }).click()
  await dialog.getByText("settings.json", { exact: true }).click()
  const editor = dialog.getByLabel("Workspace settings JSON")
  const config = JSON.parse(await editor.inputValue())
  expect(config.board.priorityPolicy).toEqual(fixture.policy)
  expect(config.board.automation).toBeUndefined()

  await test.step("Reject a changed unsupported evaluator", async () => {
    config.board.priorityPolicy.evaluator = "job-fit-v2"
    await editor.fill(JSON.stringify(config, null, 2))
    await expect(dialog.getByText("/board/priorityPolicy/evaluator", { exact: true })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Apply JSON" })).toBeDisabled()
  })

  await test.step("Add only automation settings and preserve the imported policy", async () => {
    config.board.priorityPolicy = fixture.policy
    config.board.automation = fixture.automation
    await editor.fill(JSON.stringify(config, null, 2))
    await expect(dialog.getByRole("button", { name: "Apply JSON" })).toBeEnabled()
    await dialog.getByRole("button", { name: "Apply JSON" }).click()
    await expect(dialog).toBeHidden()
  })

  await page.reload()
  await expect(page.getByRole("button", { name: /Open Example Co — Backend Engineer/ })).toBeVisible()
  await page.getByRole("button", { name: /Open Example Co — Backend Engineer/ }).click()
  const restoredCard = page.getByRole("dialog", { name: "Item overview" })
  await expect(restoredCard.getByText("Retained source text", { exact: true })).toBeVisible()
  await restoredCard.getByRole("button", { name: "Close detail" }).click()
  await page.getByRole("button", { name: "Settings" }).click()
  const savedSettings = page.getByRole("dialog", { name: "Settings" })
  await savedSettings.getByRole("tab", { name: "Workspace", exact: true }).click()
  await savedSettings.getByText("settings.json", { exact: true }).click()
  const saved = JSON.parse(await savedSettings.getByLabel("Workspace settings JSON").inputValue())
  expect(saved.board.priorityPolicy).toEqual(fixture.policy)
  expect(saved.board.automation).toEqual(fixture.automation)
})
