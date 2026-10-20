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
  const dialog = page.getByRole("dialog", { name: "Item overview" })
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
    expect(stages.y).toBeGreaterThanOrEqual(content.y)
    expect(stages.y + stages.height).toBeLessThanOrEqual(content.y + content.height)
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

test("Given workspace settings, When tabs change, Then panels fade in and reduced motion remains available", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
  await dialog.getByRole("tab", { name: "Workspace", exact: true }).click()
  const panel = dialog.getByRole("tabpanel", { name: "Workspace", exact: true })
  await expect(panel).toHaveCSS("animation-name", "panel-appear")
  await expect(panel.getByRole("button", { name: "Export .tincanban", exact: true })).toBeVisible()
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await panel.evaluate(element => Number.parseFloat(getComputedStyle(element).animationDuration))).toBeLessThan(.01)
})

for (const width of [320, 390, 1280]) test(`Given a ${width}px card window with a long role, When stages exceed one row, Then Edit stays on one line and all stage buttons wrap without horizontal scrolling`, async ({ page }, info) => {
  await populatedBoard(page, true)
  await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    const role = app.activeBoard.value!.preset!.bindings["field.role"]!
    await app.executeCommandAsync({ kind: "patchItem", entityId: "performance-card-0", values: { [role]: "Senior Software Backend RoR Engineer" } })
  })
  await page.setViewportSize({ width, height: 844 })
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Item overview" })
  const edit = dialog.getByRole("button", { name: "Edit", exact: true })
  await expect(edit).toHaveCSS("white-space", "nowrap")
  expect((await edit.boundingBox())!.width).toBeGreaterThanOrEqual(44)
  const row = dialog.locator(".status-strip")
  expect(await row.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  expect(await row.locator("button").evaluateAll(buttons => {
    const strip = buttons[0]!.parentElement!.getBoundingClientRect()
    return buttons.every(button => {
      const bounds = button.getBoundingClientRect()
      return bounds.left >= strip.left && bounds.right <= strip.right + 1
    })
  })).toBe(true)
  await expect(dialog.getByRole("button", { name: /Show (earlier|later) stages/ })).toHaveCount(0)
  await row.getByRole("button", { name: "Applied", exact: true }).click()
  await expect(row.getByRole("button", { name: "Applied", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(dialog.getByRole("status")).toHaveCount(0)
  await page.screenshot({ path: info.outputPath(`wrapped-stages-${width}.png`) })
  await edit.click()
  await expect(page.getByRole("dialog", { name: "Edit item", exact: true })).toBeVisible()
})

test("Given a card with a legacy narrow saved width, When it is resized and reopened, Then the panel stays at least 480px and keeps one compact button row", async ({ page }, info) => {
  const longTitle = "A deliberately long item title that must wrap without stacking each character vertically"
  await populatedBoard(page)
  await page.evaluate(async title => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    await app.executeCommandAsync({ kind: "patchItem", entityId: "performance-card-0", title })
    const { windowLayoutKey } = await import("/src/ui/windowManager.ts")
    localStorage.setItem(windowLayoutKey(app.activeWorkspace.id, "item:performance-card-0"), JSON.stringify({ x: 20, y: 80, width: 280, height: 460 }))
  }, longTitle)
  const card = page.getByRole("button", { name: `Open ${longTitle}`, exact: true })
  await expect(card).toBeVisible()
  await card.click()

  const dialog = page.getByRole("dialog", { name: "Item overview", exact: true })
  const resize = dialog.locator(".spatial-resize")
  let bounds = (await dialog.boundingBox())!
  const handle = (await resize.boundingBox())!
  const attemptedWidth = 380
  const targetHeight = 460
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 - (bounds.width - attemptedWidth), handle.y + handle.height / 2 - (bounds.height - targetHeight), { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBe(480)
  await resize.focus()
  await resize.press("Shift+ArrowLeft")
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBe(480)
  await resize.press("Shift+ArrowRight")
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBe(520)
  await resize.press("Shift+ArrowLeft")
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBe(480)

  const title = dialog.locator(".spatial-titlebar .detail-head h2")
  await expect(title).toHaveText(longTitle)
  await expect(title).toHaveCSS("white-space", "nowrap")
  await expect(title).toHaveCSS("text-overflow", "ellipsis")
  bounds = (await dialog.locator(".spatial-titlebar").boundingBox())!
  expect(bounds.height).toBe(64)
  const actions = (await dialog.locator(".detail-head-actions").boundingBox())!
  expect(actions.y).toBeGreaterThanOrEqual(bounds.y)
  expect(actions.y + actions.height).toBeLessThanOrEqual(bounds.y + bounds.height)
  const actionButtons = await dialog.locator(".detail-head-actions .button").evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().y))
  expect(new Set(actionButtons).size).toBe(1)
  const outerButtonRows = await dialog.locator(".spatial-controls button").evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().y))
  expect(new Set(outerButtonRows).size).toBe(1)
  const scroll = dialog.locator(".scroll-frame-viewport")
  await expect(scroll).toBeVisible()
  expect(await scroll.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await page.screenshot({ path: info.outputPath("minimum-width-card-title.png") })

  await dialog.getByRole("button", { name: "Dismiss", exact: true }).click()
  await expect(dialog).toBeHidden()
  await card.click()
  await expect.poll(async () => (await dialog.boundingBox())?.width ?? 0).toBe(480)
  await expect(title).toBeVisible()

  await page.setViewportSize({ width: 320, height: 260 })
  bounds = (await dialog.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(260)
  const shortTitle = (await title.boundingBox())!
  expect(shortTitle.width).toBeGreaterThan(40)
  expect(shortTitle.height).toBeLessThan(50)
  const shortBar = (await dialog.locator(".spatial-titlebar").boundingBox())!
  expect(shortBar.height).toBe(64)
  const shortActionRows = await dialog.locator(".detail-head-actions .button").evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().y))
  expect(new Set(shortActionRows).size).toBe(1)
  const closeBounds = (await dialog.getByRole("button", { name: "Dismiss", exact: true }).boundingBox())!
  expect(closeBounds.y).toBeGreaterThanOrEqual(shortBar.y)
  expect(closeBounds.y + closeBounds.height).toBeLessThanOrEqual(shortBar.y + shortBar.height)
  expect(await scroll.evaluate(element => element.clientHeight)).toBeGreaterThan(64)
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect(dialog.getByRole("button", { name: "Close detail", exact: true })).toBeVisible()
})
