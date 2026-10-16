import { expect, test, type Page } from "./support/coverage"

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

async function safeInsets(page: Page) {
  // Headless WebKit has no native home indicator; supply its reserved insets.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-top", "20px")
    document.documentElement.style.setProperty("--safe-bottom", "34px")
  })
}

async function coveredBackdrop(page: Page) {
  const overlay = page.locator(".overlay").last()
  await expect(overlay).toBeVisible()
  await expect.poll(() => overlay.evaluate(element => getComputedStyle(element).opacity)).toBe("1")
  const paint = await overlay.evaluate(element => {
    const box = element.getBoundingClientRect()
    const backdrop = getComputedStyle(element, "::before")
    return { bottom: box.bottom, viewport: innerHeight, extraBottom: backdrop.bottom, color: backdrop.backgroundColor, paddingBottom: getComputedStyle(element).paddingBottom }
  })
  expect(paint.bottom).toBe(paint.viewport)
  expect(paint.extraBottom).toBe("-34px")
  expect(paint.color).toBe("rgba(23, 23, 23, 0.72)")
  expect(paint.paddingBottom).toBe("34px")
}

test("Given mobile board with safe insets, when Sync opens and viewport changes, then backdrop reaches bottom and closing restores board", async ({ page }, info) => {
  await page.goto("/")
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/)
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible()
  await safeInsets(page)
  await page.getByRole("button", { name: "Menu", exact: true }).tap()
  await page.getByRole("button", { name: "Sync & backups", exact: true }).tap()
  const dialog = page.getByRole("dialog", { name: "Device sync", exact: true })
  await expect(dialog).toBeVisible()
  await expect(page.locator(".mobile-drawer-root")).toHaveCount(0)
  for (const height of [844, 620, 844]) {
    await page.setViewportSize({ width: 390, height })
    await coveredBackdrop(page)
    await expect.poll(async () => {
      const bounds = (await dialog.boundingBox())!
      return bounds.y >= 20 && bounds.y + bounds.height <= height - 34 + .1
    }).toBe(true)
  }
  await page.screenshot({ path: info.outputPath("mobile-sync-bottom.png") })
  await dialog.getByRole("button", { name: "Close", exact: true }).tap()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("button", { name: "Workspace chat", exact: true })).toBeVisible()
})

test("Given scrolled mobile board, when a visible Add item opens and closes, then scroll position returns", async ({ page }) => {
  await page.goto("/")
  await safeInsets(page)
  const add = page.getByRole("button", { name: "Add item to To do", exact: true })
  await expect(add).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 120))
  const scroll = await page.evaluate(() => window.scrollY)
  expect(scroll).toBeGreaterThan(0)
  await add.tap()
  const dialog = page.getByRole("dialog", { name: "Item details", exact: true })
  await expect(dialog).toBeVisible()
  await coveredBackdrop(page)
  await dialog.getByRole("button", { name: "Cancel", exact: true }).tap()
  await expect(dialog).toBeHidden()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll)
})

test("Given invalid mobile pairing link, when error opens, then backdrop covers safe area and Dismiss returns to board", async ({ page }, info) => {
  await page.goto("/pair#invalid")
  await safeInsets(page)
  const dialog = page.getByRole("dialog", { name: "Device sync", exact: true })
  await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 25_000 })
  await coveredBackdrop(page)
  await page.screenshot({ path: info.outputPath("mobile-pairing-failure-bottom.png") })
  await dialog.getByRole("button", { name: "Dismiss", exact: true }).tap()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("button", { name: "Workspace chat", exact: true })).toBeVisible()
})

test("Given mobile chat with safe insets, when viewport shrinks and message sends, then composer stays reachable and message appears", async ({ page }, info) => {
  await page.goto("/")
  await safeInsets(page)
  await page.getByRole("button", { name: "Workspace chat", exact: true }).tap()
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  for (const height of [844, 540]) {
    await page.setViewportSize({ width: 390, height })
    const bounds = (await chat.boundingBox())!
    expect(bounds.y).toBeGreaterThanOrEqual(20)
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(height - 34)
    await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toBeVisible()
  }
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Mobile edge check")
  await chat.getByRole("button", { name: "Send message", exact: true }).tap()
  await expect(chat.getByText("Mobile edge check", { exact: true })).toBeVisible()
  await expect(chat.getByRole("button", { name: "Send message", exact: true })).toHaveText("Send")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: info.outputPath("mobile-chat-bottom.png") })
  await chat.getByRole("button", { name: "Close", exact: true }).tap()
  await expect(chat).toHaveCount(0)
})
