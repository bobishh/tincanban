import { expect, test } from "./support/coverage"

for (const width of [1440, 390]) {
  test(`Given a configured board at ${width}px, when literal and structured fields are edited, then ordered schema fields choose compact or full rows`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const creation = page.getByRole("dialog", { name: "Create workspace" })
    await creation.getByLabel("Title", { exact: true }).fill("Configured fields")
    await creation.getByRole("button", { name: "Create", exact: true }).click()
    await expect(creation).toBeHidden()
    await page.evaluate(async () => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const { projectWorkspaceSettings } = await import("/src/domain/workspaceSettings.ts")
      const app = useTincanban()
      const settings = projectWorkspaceSettings(app.getActiveDoc()!)
      settings.board.fields = [
        { title: "Source text", valueType: "text", required: false },
        { title: "Payload", valueType: "text", required: false, format: "json" },
        { title: "Snippet", valueType: "text", required: false, format: "code" },
        { title: "Summary", valueType: "text", required: false },
      ]
      await app.executeCommandAsync({ kind: "updateWorkspaceSettings", settings })
    })
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const form = page.getByRole("dialog", { name: "Item details", exact: true })
    await form.getByLabel("Title *").fill("Release checklist")
    await form.getByLabel("Source text", { exact: true }).fill('{"decision": not JSON, just text')
    await form.getByLabel("Payload", { exact: true }).fill("{broken")
    await form.getByLabel("Snippet", { exact: true }).fill('<script>window.unwanted = true</script>')
    await form.getByLabel("Summary", { exact: true }).fill("3 gates left")
    await form.getByRole("button", { name: "Save item", exact: true }).click()
    await expect(form.getByRole("alert")).toContainText("Payload must be valid JSON")
    await expect(form.getByLabel("Source text", { exact: true })).toHaveValue('{"decision": not JSON, just text')
    await form.getByLabel("Payload", { exact: true }).fill('{"release":"2026.10","approved":false}')
    await form.getByRole("button", { name: "Save item", exact: true }).click()
    await page.getByRole("button", { name: "Open Release checklist", exact: true }).click()
    const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
    await expect(detail).toContainText('{"decision": not JSON, just text')
    await expect(detail.getByText("Source snapshot", { exact: true })).toHaveCount(0)
    await expect(detail.locator("pre").filter({ hasText: '"approved":false' })).toBeVisible()
    expect(await page.evaluate(() => (window as Window & { unwanted?: boolean }).unwanted)).toBeUndefined()
    await detail.getByRole("button", { name: "Edit", exact: true }).click()
    const edit = page.getByRole("dialog", { name: "Edit item", exact: true })
    await edit.getByLabel("Source text", { exact: true }).fill("Release readiness notes: compatibility, staged rollout, support coverage, rollback ownership, and final approval. ".repeat(3))
    await edit.getByLabel("Snippet", { exact: true }).fill('const rollbackPlan = "ready";')
    await edit.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect(edit).toBeHidden()
    await page.reload()
    await page.getByRole("button", { name: "Open Release checklist", exact: true }).click()
    const restoredDetail = page.getByRole("dialog", { name: "Item overview", exact: true })
    await expect(restoredDetail).toContainText("Release readiness notes")
    const grid = restoredDetail.locator(".configured-card-fields")
    const fields = grid.locator(".configured-card-field")
    await expect(fields).toHaveCount(4)
    const rendered = await fields.evaluateAll(elements => elements.map(element => ({ title: element.querySelector("dt")?.textContent, wide: element.classList.contains("configured-card-field-wide") })))
    const schemaOrder = await page.evaluate(async () => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const { projectBoardSchema } = await import("/src/domain/schema.ts")
      const app = useTincanban()
      return projectBoardSchema(app.getActiveDoc()!, app.activeBoard.value!.id).fields.map(field => field.title)
    })
    expect(rendered.map(field => field.title)).toEqual(schemaOrder)
    expect(Object.fromEntries(rendered.map(field => [field.title, field.wide]))).toEqual({ "Source text": true, Payload: true, Snippet: true, Summary: false })
    const gridColumnCount = await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length)
    expect(gridColumnCount).toBe(width === 390 ? 1 : 2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    if (width === 1440) await page.screenshot({ path: testInfo.outputPath("release-checklist-detail.png") })
  })
}

for (const width of [1440, 390]) {
  test(`Given a mixed dynamic schema at ${width}px, when opening a release checklist, then every value type keeps rank order and long content wraps`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const creation = page.getByRole("dialog", { name: "Create workspace" })
    await creation.getByLabel("Title", { exact: true }).fill("Release checklist")
    await creation.getByRole("button", { name: "Create", exact: true }).click()
    await expect(creation).toBeHidden()

    const longUrl = `https://example.test/releases/2026.10/${"rollout-".repeat(18)}`
    const releaseNotes = `### Rollout plan\n\nShip to **production** after the [smoke run](https://example.test/smoke). ${"Confirm rollback owner, support coverage, and dashboard readiness. ".repeat(3)}`
    await page.evaluate(async ({ longUrl, releaseNotes }) => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const { projectWorkspaceSettings } = await import("/src/domain/workspaceSettings.ts")
      const { projectBoardSchema } = await import("/src/domain/schema.ts")
      const app = useTincanban()
      const doc = app.getActiveDoc()!
      const settings = projectWorkspaceSettings(doc)
      settings.board.fields = [
        { title: "Owner", valueType: "text", required: false },
        { title: "Payload", valueType: "text", required: false, format: "json" },
        { title: "Snippet", valueType: "text", required: false, format: "code" },
        { title: "Release notes", valueType: "text", required: false, format: "markdown" },
        { title: "Ticket count", valueType: "number", required: false, min: 0 },
        { title: "Published", valueType: "boolean", required: false },
        { title: "Target", valueType: "select", required: false, options: [{ title: "Staging" }, { title: "Production" }] },
        { title: "Source URL", valueType: "url", required: false },
        { title: "Deadline", valueType: "date", required: false },
        { title: "Kickoff", valueType: "datetime", required: false },
        { title: "Unassigned", valueType: "text", required: false },
      ]
      await app.executeCommandAsync({ kind: "updateWorkspaceSettings", settings })
      const board = Object.values(app.getActiveDoc()!.entities).find((entity: any) => entity.kind === "board")!
      const schema = projectBoardSchema(app.getActiveDoc()!, board.id)
      const field = (title: string) => schema.fields.find(entry => entry.title === title)!
      const values = {
        [field("Owner").id!]: "Mara",
        [field("Payload").id!]: '{"release":"2026.10","approved":false}',
        [field("Snippet").id!]: 'const rollbackPlan = "ready";',
        [field("Release notes").id!]: releaseNotes,
        [field("Ticket count").id!]: 0,
        [field("Published").id!]: false,
        [field("Target").id!]: field("Target").options![1].id!,
        [field("Source URL").id!]: longUrl,
        [field("Deadline").id!]: "2026-10-20",
        [field("Kickoff").id!]: "2026-10-20T09:30",
      }
      await app.executeCommandAsync({ kind: "createItem", parentId: schema.columns[0].id!, title: "Release checklist", body: "", values })
    }, { longUrl, releaseNotes })

    await page.getByRole("button", { name: "Open Release checklist", exact: true }).click()
    const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
    const grid = detail.locator(".configured-card-fields")
    const fields = grid.locator(".configured-card-field")
    await expect(fields).toHaveCount(10)
    const rendered = await fields.evaluateAll(elements => elements.map(element => ({
      id: element.getAttribute("data-field-id"),
      title: element.querySelector("dt")?.textContent,
      wide: element.classList.contains("configured-card-field-wide"),
    })))
    const schemaOrder = await page.evaluate(async () => {
      const { useTincanban } = await import("/src/test/stateFixture.ts")
      const { projectBoardSchema } = await import("/src/domain/schema.ts")
      const app = useTincanban()
      const board = Object.values(app.getActiveDoc()!.entities).find((entity: any) => entity.kind === "board")!
      return projectBoardSchema(app.getActiveDoc()!, board.id).fields
        .filter(field => field.title !== "Unassigned").map(field => ({ id: field.id, title: field.title }))
    })
    expect(rendered.map(({ id, title }) => ({ id, title }))).toEqual(schemaOrder)
    expect(Object.fromEntries(rendered.map(field => [field.title, field.wide]))).toEqual({
      Owner: false, Payload: true, Snippet: true, "Release notes": true, "Ticket count": false,
      Published: false, Target: false, "Source URL": true, Deadline: false, Kickoff: false,
    })
    await expect(grid.locator('[data-field-id]').filter({ has: page.getByText("Published", { exact: true }) })).toContainText("No")
    await expect(grid.locator('[data-field-id]').filter({ has: page.getByText("Ticket count", { exact: true }) })).toContainText("0")
    await expect(grid.getByText("Unassigned", { exact: true })).toHaveCount(0)
    await expect(grid.getByText("Mara", { exact: true })).toBeVisible()
    await expect(grid.getByText("Production", { exact: true })).toBeVisible()
    const link = grid.locator('[data-field-id]').filter({ has: page.getByText("Source URL", { exact: true }) }).locator("a")
    await expect(link).toHaveAttribute("href", longUrl)
    await expect(grid.locator('[data-field-id]').filter({ has: page.getByText("Release notes", { exact: true }) }).locator("a")).toHaveAttribute("href", "https://example.test/smoke")
    expect(await grid.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    const gridColumnCount = await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length)
    expect(gridColumnCount).toBe(width === 390 ? 1 : 2)
    if (width === 1440) {
      await page.getByRole("button", { name: "Dismiss notice" }).click()
      await page.waitForTimeout(400)
      await page.screenshot({ path: testInfo.outputPath("release-checklist-mixed-schema.png") })
    }
  })
}
