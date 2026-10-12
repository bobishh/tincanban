import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given a 640px board, when resizing to a phone, then compact columns become a navigable single column only at 560px", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 640, height: 900 })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await expect(page.locator(".mobile-column-switcher")).toBeHidden()
  const columns = page.locator(".board > .column")
  const first = (await columns.nth(0).boundingBox())!
  const second = (await columns.nth(1).boundingBox())!
  expect(first.width).toBeLessThan(300)
  expect(second.x + second.width).toBeLessThanOrEqual(640)
  await page.screenshot({ path: testInfo.outputPath("compact-board-640.png"), fullPage: true })
  await page.getByRole("searchbox", { name: "Search cards" }).fill("No matching vacancy")
  await expect(page.locator(".board-empty")).toBeVisible()
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(columns.first()).toBeVisible()
  await expect(page.locator(".mobile-column-switcher")).toBeHidden()
  await page.setViewportSize({ width: 560, height: 900 })
  await expect(page.locator(".mobile-column-switcher")).toHaveCount(0)
  await page.locator(".board").evaluate(element => {
    const column = element.querySelectorAll<HTMLElement>(".column")[1]!
    element.scrollTo({ left: column.offsetLeft, behavior: "instant" })
  })
  await expect.poll(() => page.locator(".board").evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  await page.setViewportSize({ width: 561, height: 900 })
  await expect(page.locator(".mobile-column-switcher")).toBeHidden()
  await expect.poll(async () => (await columns.nth(0).boundingBox())?.width).toBeLessThan(300)
})
