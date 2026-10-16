import { expect, test } from "./support/coverage"
import { populatedBoard } from "./support/detailedBoard"

for (const width of [390, 1280]) test(`Given a detailed lead at ${width}px, When its window opens and scrolls, Then motion is smooth and framed content keeps most of the window`, async ({ page }, info) => {
  await populatedBoard(page, true)
  await page.setViewportSize({ width, height: 844 })
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-top", "20px")
    document.documentElement.style.setProperty("--safe-bottom", "34px")
  })
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Lead details" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveCSS("animation-name", "window-appear")
  const scroll = dialog.locator(".scroll-frame-viewport")
  await expect(scroll).toBeVisible()
  await expect(dialog).toHaveCSS("border-top-width", "2px")
  await expect(dialog.locator(".scroll-frame")).toHaveCSS("border-top-width", "0px")
  const thumb = dialog.locator(".scroll-frame-thumb")
  await expect(thumb).toBeVisible()
  const initialThumb = await thumb.boundingBox()
  if (width < 600) {
    const bounds = (await dialog.boundingBox())!
    const title = (await dialog.locator(".spatial-titlebar").boundingBox())!
    const stages = (await dialog.locator(".status-strip").boundingBox())!
    const content = (await scroll.boundingBox())!
    expect(title.height).toBeLessThan(110)
    expect(stages.height).toBeLessThan(58)
    expect(content.height).toBeGreaterThan(bounds.height * .65)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844 - 34)
    await expect(dialog.getByRole("heading", { name: "Performance card 0", exact: true })).toHaveCount(1)
  } else {
    await dialog.getByRole("button", { name: "Maximize window", exact: true }).click()
    await expect(dialog).toHaveCSS("transition-property", "left, top, width, height")
    await dialog.getByRole("button", { name: "Restore window size", exact: true }).click()
  }
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(async () => (await thumb.boundingBox())!.y).toBeGreaterThan(initialThumb!.y)
  await dialog.evaluate(async element => { await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))) })
  await page.screenshot({ path: info.outputPath(`lead-window-${width}.png`) })
  if (width < 600) {
    await page.setViewportSize({ width, height: 540 })
    const compact = (await dialog.boundingBox())!
    expect(compact.y + compact.height).toBeLessThanOrEqual(540 - 34)
    expect((await scroll.boundingBox())!.height).toBeGreaterThan(240)
  }
  await page.emulateMedia({ reducedMotion: "reduce" })
  await dialog.getByRole("button", { name: "Close detail" }).click()
  await page.getByRole("button", { name: "Open Performance card 1", exact: true }).click()
  await expect(dialog).toBeVisible()
  expect(await dialog.evaluate(element => Number.parseFloat(getComputedStyle(element).animationDuration))).toBeLessThan(.01)
})

test("Given sync settings, When tabs change, Then panels fade in and reduced motion remains available", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("tab", { name: "Backups", exact: true }).click()
  const panel = dialog.getByRole("tabpanel", { name: "Backups", exact: true })
  await expect(panel).toHaveCSS("animation-name", "panel-appear")
  await expect(panel.getByRole("button", { name: "Export .tincanban", exact: true })).toBeVisible()
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await panel.evaluate(element => Number.parseFloat(getComputedStyle(element).animationDuration))).toBeLessThan(.01)
})

for (const width of [320, 390]) test(`Given a ${width}px lead window with a long role, When stages overflow, Then Edit stays on one line and arrows reveal hidden stages`, async ({ page }, info) => {
  await populatedBoard(page, true)
  await page.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
    const role = app.activeBoard.value!.preset!.bindings["field.role"]!
    await app.executeCommandAsync({ kind: "patchItem", entityId: "performance-card-0", values: { [role]: "Senior Software Backend RoR Engineer" } })
  })
  await page.setViewportSize({ width, height: 844 })
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Lead details" })
  const edit = dialog.getByRole("button", { name: "Edit", exact: true })
  await expect(edit).toHaveCSS("white-space", "nowrap")
  expect((await edit.boundingBox())!.width).toBeGreaterThanOrEqual(44)
  const next = dialog.getByRole("button", { name: "Show later stages", exact: true })
  const previous = dialog.getByRole("button", { name: "Show earlier stages", exact: true })
  await expect(next).toBeVisible()
  await expect(previous).toHaveCount(0)
  await next.click()
  await expect(previous).toBeVisible()
  const row = dialog.locator(".status-strip")
  await row.evaluate(element => { element.scrollLeft = element.scrollWidth })
  await expect(next).toHaveCount(0)
  await expect(previous).toBeVisible()
  await page.emulateMedia({ reducedMotion: "reduce" })
  await previous.click()
  await expect(next).toBeVisible()
  await page.screenshot({ path: info.outputPath(`stage-hints-${width}.png`) })
  await edit.click()
  await expect(page.getByRole("dialog", { name: "Edit item", exact: true })).toBeVisible()
})
