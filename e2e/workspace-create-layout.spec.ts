import { expect, test } from "./support/coverage"

for (const width of [1440, 390]) {
  test(`Given a ${width}px viewport, when creating a workspace, then controls fit the viewport and validation allows recovery`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    const titleInput = dialog.getByLabel("Title", { exact: true })
    await titleInput.focus()
    await expect(titleInput).toBeFocused()
    const focus = await titleInput.evaluate(element => {
      const rect = element.getBoundingClientRect()
      const viewport = element.closest(".workspace-create-content")!
      const clip = viewport.getBoundingClientRect()
      const style = getComputedStyle(element)
      const outset = Number.parseFloat(style.borderImageOutset)
      return { source: style.borderImageSource, left: rect.left - outset - clip.left,
        right: clip.left + viewport.clientWidth - rect.right - outset }
    })
    expect(focus.source).toContain("ink-focus")
    expect(focus.left, "left dotted focus contour stays inside scroll viewport").toBeGreaterThanOrEqual(0)
    expect(focus.right, "right dotted focus contour stays inside scroll viewport").toBeGreaterThanOrEqual(0)
    await expect(dialog.getByRole("radio")).toHaveCount(0)
    await dialog.getByRole("button", { name: "Create", exact: true }).click()
    await expect(dialog.getByRole("alert")).toHaveText("Workspace title is required")
    await dialog.getByLabel("Title", { exact: true }).fill("New board")
    await dialog.getByRole("button", { name: "Create", exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole("heading", { name: /^TINCANBAN(?: \/\/)? New board$/ })).toBeVisible()
    await expect(page.getByRole("region", { name: "To do", exact: true })).toBeVisible()
  })
}
