import { expect, test } from "./support/coverage"

test("Given a workspace creation draft, when the active board changes during background loading, then retain the draft and create the named board", async ({ page }) => {
  await page.goto("/")
  const originalId = await page.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
    await app.whenReady()
    const originalId = app.activeWorkspace.id
    await app.createWorkspaceAsync("Background selection", "blank")
    return originalId
  })
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
  await page.getByRole("button", { name: "New workspace", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace", exact: true })
  await dialog.getByLabel("Title", { exact: true }).fill("Retained creation draft")
  await page.evaluate(async id => (await import("/src/state.ts")).useTincanban().switchWorkspace(id), originalId)
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("Retained creation draft")
  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await expect(page.getByRole("region", { name: "Retained creation draft", exact: true })).toBeVisible()
  await expect(dialog).toBeHidden()
})

for (const width of [390]) {
  test(`Given a ${width}px viewport, when creating a workspace, then validation rejects an empty title and a valid workspace is saved`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    const titleInput = dialog.getByLabel("Title", { exact: true })
    await titleInput.focus()
    await expect(titleInput).toBeFocused()
    await dialog.getByRole("button", { name: "Create", exact: true }).click()
    await expect(dialog.getByRole("alert")).toHaveText("Workspace title is required")
    await dialog.getByLabel("Title", { exact: true }).fill("New board")
    await dialog.getByRole("button", { name: "Create", exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole("heading", { name: /^TINCANBAN(?: \/\/)? New board$/ })).toBeVisible()
    await expect(page.getByRole("region", { name: "To do", exact: true })).toBeVisible()
  })
}
