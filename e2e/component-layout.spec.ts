import { expect, test, type Locator, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function createBlankWorkspace(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill("Layout audit")
  await dialog.getByRole("radio", { name: "Blank board" }).check()
  await dialog.getByRole("button", { name: "Create" }).click()
}

async function expectInsideViewport(locator: Locator, page: Page) {
  await expect(locator).toHaveCSS("transform", "none")
  const box = await locator.boundingBox()
  const viewport = page.viewportSize()
  expect(box).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.y).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width)
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height)
}

test.describe("Component layout audit", () => {
  test("Given a wide desktop, when all job columns fit, then the board uses available width without horizontal scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 })
    await page.goto("/")
    await ensureJobSearchWorkspace(page)

    const geometry = await page.getByRole("region", { name: "Job search" }).evaluate((board) => ({
      clientWidth: board.clientWidth,
      scrollWidth: board.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }))
    expect(geometry.clientWidth).toBe(geometry.viewportWidth)
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth)
  })

  test("Given desktop viewport, when recent dialogs open, then spacing and geometry stay consistent", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await createBlankWorkspace(page)

    await page.getByRole("button", { name: "Settings" }).click()
    let dialog = page.getByRole("dialog", { name: "Settings" })
    await expectInsideViewport(dialog, page)
    await dialog.getByRole("tab", { name: "Workspace", exact: true }).click()
    await expect(dialog.getByRole("tab", { name: "Document templates" })).toHaveCSS("border-radius", "0px")
    await dialog.getByRole("tab", { name: "Workspace", exact: true }).click()
    await dialog.getByText("settings.json", { exact: true }).click()
    await expect(dialog.getByLabel("Workspace settings JSON")).toBeVisible()
    await dialog.getByRole("button", { name: "Dismiss" }).click()

    await page.getByRole("button", { name: "Edit board" }).click()
    await page.getByRole("button", { name: "Edit item" }).click()
    dialog = page.getByRole("dialog", { name: "Edit item" })
    await expectInsideViewport(dialog, page)
    await dialog.getByRole("button", { name: "Dismiss" }).click()

    await page.getByRole("region", { name: "To do" }).getByRole("button", { name: "Edit column" }).click()
    dialog = page.getByRole("dialog", { name: "Edit column" })
    await expectInsideViewport(dialog, page)
    await dialog.getByRole("button", { name: "Close" }).click()
  })

  test("Given mobile viewport, when navigation and settings open, then neither surface escapes viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await createBlankWorkspace(page)
    await page.getByRole("button", { name: "Menu" }).click()
    const drawer = page.getByRole("dialog", { name: "Navigation menu" })
    await expectInsideViewport(drawer, page)
    await drawer.getByRole("button", { name: "Settings" }).click()
    const dialog = page.getByRole("dialog", { name: "Settings" })
    await expectInsideViewport(dialog, page)
    await dialog.getByRole("tab", { name: "Workspace", exact: true }).click()
    await dialog.getByText("settings.json", { exact: true }).click()
    await expectInsideViewport(dialog, page)
  })
})
