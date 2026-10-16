import { expect, test } from "./support/coverage"

test.describe("Agent guide", () => {
  test("Given a narrow viewport, when the guide opens, then content remains within the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/agent/")

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(hasHorizontalOverflow).toBe(false)
  })
})
