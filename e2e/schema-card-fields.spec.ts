import { expect, test } from "./support/coverage"

for (const width of [1440, 390]) {
  test(`Given a configured board at ${width}px, when literal and structured fields are edited, then only explicit formats apply and drafts survive failure`, async ({ page }) => {
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
      ]
      await app.executeCommandAsync({ kind: "updateWorkspaceSettings", settings })
    })
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const form = page.getByRole("dialog", { name: "Item details", exact: true })
    await form.getByLabel("Title *").fill("Literal content")
    await form.getByLabel("Source text", { exact: true }).fill('{"decision": not JSON, just text')
    await form.getByLabel("Payload", { exact: true }).fill("{broken")
    await form.getByLabel("Snippet", { exact: true }).fill('<script>window.unwanted = true</script>')
    await form.getByRole("button", { name: "Save item", exact: true }).click()
    await expect(form.getByRole("alert")).toContainText("Payload must be valid JSON")
    await expect(form.getByLabel("Source text", { exact: true })).toHaveValue('{"decision": not JSON, just text')
    await form.getByLabel("Payload", { exact: true }).fill('{"ok":true}')
    await form.getByRole("button", { name: "Save item", exact: true }).click()
    await page.getByRole("button", { name: "Open Literal content", exact: true }).click()
    const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
    await expect(detail).toContainText('{"decision": not JSON, just text')
    await expect(detail.getByText("Source snapshot", { exact: true })).toHaveCount(0)
    await expect(detail.locator("pre").filter({ hasText: '"ok":true' })).toBeVisible()
    expect(await page.evaluate(() => (window as Window & { unwanted?: boolean }).unwanted)).toBeUndefined()
    await detail.getByRole("button", { name: "Edit", exact: true }).click()
    const edit = page.getByRole("dialog", { name: "Edit item", exact: true })
    await edit.getByLabel("Source text", { exact: true }).fill("Edited ordinary text")
    await edit.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect(edit).toBeHidden()
    await page.reload()
    await page.getByRole("button", { name: "Open Literal content", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Item overview", exact: true })).toContainText("Edited ordinary text")
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  })
}
