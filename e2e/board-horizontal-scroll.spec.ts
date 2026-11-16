import { expect, test } from "./support/coverage"

test("Given a wide board, when scrolling the page, then the top scrollbar still moves the columns", async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 420 })
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title").fill("Wide board")
  await create.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByRole("button", { name: "Edit board" }).click()
  for (const title of ["Review", "Later"]) {
    await page.getByRole("textbox", { name: "New column" }).fill(title)
    await page.getByRole("button", { name: "+ Add column" }).click()
    await expect(page.getByRole("region", { name: title, exact: true })).toBeVisible()
  }
  await page.getByRole("button", { name: "Done", exact: true }).click()

  const board = page.getByRole("region", { name: "Wide board", exact: true })
  const scrollbar = page.getByRole("slider", { name: "Scroll board horizontally" })
  await expect(scrollbar).toBeVisible()
  await scrollbar.press("Home")
  await page.evaluate(() => window.scrollTo(0, 300))
  const [track, header] = await Promise.all([
    scrollbar.boundingBox(),
    page.locator(".topbar").boundingBox(),
  ])
  expect(track!.y).toBeGreaterThanOrEqual(header!.y + header!.height)
  expect(track!.y).toBeLessThan(120)

  await page.mouse.move(track!.x + 5, track!.y + track!.height / 2)
  await page.mouse.down()
  await page.mouse.move(track!.x + track!.width - 5, track!.y + track!.height / 2, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => board.evaluate(el => el.scrollWidth - el.clientWidth - el.scrollLeft)).toBeLessThan(2)

  await scrollbar.press("Home")
  await expect.poll(() => board.evaluate(el => el.scrollLeft)).toBe(0)
  await page.mouse.move(400, 200)
  await page.keyboard.down("Shift")
  await page.mouse.wheel(0, 180)
  await page.keyboard.up("Shift")
  await expect.poll(() => board.evaluate(el => el.scrollLeft)).toBeGreaterThan(100)
  await expect.poll(() => scrollbar.inputValue()).not.toBe("0")

  const topGap = () => board.evaluate(el => el.getBoundingClientRect().top - el.parentElement!.getBoundingClientRect().top)
  const originalGap = await topGap()
  await page.getByRole("searchbox", { name: "Search cards" }).fill("no card matches this")
  await expect(page.getByText("No matching cards", { exact: true })).toBeVisible()
  await expect(scrollbar).toBeHidden()
  expect(await topGap()).toBeCloseTo(originalGap, 1)
  await expect(board).toContainText("Try another search")
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(scrollbar).toBeVisible()
  await expect(scrollbar).toHaveValue("0")
})
