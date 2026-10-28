import { expect, test, type Page } from "./support/coverage"

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

async function safeInsets(page: Page) {
  // Headless WebKit has no native home indicator; supply its reserved insets.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--safe-top", "20px")
    document.documentElement.style.setProperty("--safe-bottom", "34px")
  })
}

test("Given mobile board with safe insets, when Sync opens and viewport changes, then its window stays inside safe bounds and the board remains visible", async ({ page }, info) => {
  await page.goto("/")
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/)
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible()
  await safeInsets(page)
  await page.getByRole("button", { name: "Menu", exact: true }).tap()
  await page.getByRole("button", { name: "Sync", exact: true }).tap()
  const dialog = page.getByRole("dialog", { name: "Device sync", exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveClass(/spatial-window/)
  await expect(page.locator(".mobile-drawer-root")).toHaveCount(0)
  for (const height of [844, 620, 844]) {
    await page.setViewportSize({ width: 390, height })
    await expect(page.locator(".overlay")).toHaveCount(0)
    await expect.poll(async () => {
      const bounds = await dialog.boundingBox()
      return bounds !== null && bounds.y >= 20 && bounds.y + bounds.height <= height - 34 + .1
    }).toBe(true)
  }
  await page.screenshot({ path: info.outputPath("mobile-sync-bottom.png") })
  await dialog.getByRole("button", { name: "Close", exact: true }).tap()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("button", { name: "Workspace chat", exact: true })).toBeVisible()
})

test("Given scrolled mobile board, when a visible Add item opens and closes, then its window keeps the board visible and restores scroll", async ({ page }, info) => {
  await page.goto("/")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 25_000 })
  await safeInsets(page)
  const add = page.getByRole("button", { name: "Add item to To do", exact: true })
  await expect(add).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 120))
  const scroll = await page.evaluate(() => window.scrollY)
  expect(scroll).toBeGreaterThan(0)
  await add.tap()
  const dialog = page.getByRole("dialog", { name: "Item details", exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveClass(/spatial-window/)
  await expect(page.locator(".overlay")).toHaveCount(0)
  await expect(page.getByRole("region", { name: "To do", exact: true })).toBeVisible()
  await page.screenshot({ path: info.outputPath("mobile-item-window-scrolled-board.png") })
  await dialog.getByRole("button", { name: "Cancel", exact: true }).tap()
  await expect(dialog).toBeHidden()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll)
})

test("Given invalid mobile pairing link, when error opens, then failure stays in its window and can be dismissed", async ({ page }, info) => {
  await page.goto("/pair#invalid")
  await safeInsets(page)
  const dialog = page.getByRole("dialog", { name: "Device sync", exact: true })
  await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 25_000 })
  await expect(dialog).toHaveClass(/spatial-window/)
  await expect(page.locator(".overlay")).toHaveCount(0)
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
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: info.outputPath("mobile-chat-bottom.png") })
  await chat.getByRole("button", { name: "Close", exact: true }).tap()
  await expect(chat).toHaveCount(0)
})
