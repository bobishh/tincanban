import { expect, test } from "./support/coverage"

test("Given a wide board, when dragging headers and empty space, then the board pans and its controls still work", async ({ page }) => {
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
    if (title === "Review") await page.getByLabel("Allow this column to collapse").check()
    await page.getByRole("button", { name: "+ Add column" }).click()
    await expect(page.getByRole("region", { name: title, exact: true })).toBeVisible()
  }
  await page.getByRole("button", { name: "Done", exact: true }).click()

  const board = page.getByRole("region", { name: "Wide board", exact: true })
  await expect(page.getByRole("slider", { name: "Scroll board horizontally" })).toHaveCount(0)
  const scrollLeft = () => board.evaluate(el => el.scrollLeft)
  const header = board.getByRole("region", { name: "Doing", exact: true }).locator(".column-header")
  await page.evaluate(() => window.scrollTo(0, 0))
  await board.evaluate(el => { el.scrollLeft = 0 })
  await expect.poll(scrollLeft).toBe(0)
  await expect(header).toHaveCSS("cursor", "grab")
  const bounds = (await header.boundingBox())!
  const x = bounds.x + bounds.width / 2
  const y = bounds.y + bounds.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await expect(board).toHaveCSS("cursor", "grabbing")
  await page.mouse.move(x - 130, y, { steps: 6 })
  await page.mouse.up()
  await expect.poll(scrollLeft).toBeGreaterThan(100)
  await expect(board).toHaveCSS("cursor", "grab")

  const column = (await board.getByRole("region", { name: "Doing", exact: true }).boundingBox())!
  const gap = { x: column.x + column.width + 6, y: column.y + 75 }
  await page.mouse.move(gap.x, gap.y)
  expect(await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, gap)).toBe("grab")
  await page.mouse.down()
  await page.mouse.move(gap.x + 150, gap.y, { steps: 6 })
  await page.mouse.up()
  await expect.poll(scrollLeft).toBe(0)

  const empty = board.getByRole("region", { name: "Doing", exact: true }).locator(".empty-column")
  await expect(empty).toHaveCSS("cursor", "grab")
  await empty.scrollIntoViewIfNeeded()
  const emptyBounds = (await empty.boundingBox())!
  const emptyX = emptyBounds.x + emptyBounds.width / 2
  const emptyY = emptyBounds.y + emptyBounds.height / 2
  await page.mouse.move(emptyX, emptyY)
  await page.mouse.down()
  await expect(board).toHaveCSS("cursor", "grabbing")
  await page.mouse.move(emptyX - 100, emptyY)
  await page.mouse.up()
  await expect.poll(scrollLeft).toBeGreaterThan(75)
  await board.press("ArrowRight")
  await expect.poll(scrollLeft).toBeGreaterThan(100)

  await board.getByRole("button", { name: "Collapse Review", exact: true }).click()
  await expect(board.getByRole("button", { name: /Open Review with/ })).toBeVisible()
  await board.getByRole("button", { name: /Open Review with/ }).click()
  await board.evaluate(el => { el.scrollLeft = 0 })
  await expect.poll(scrollLeft).toBe(0)
  await header.scrollIntoViewIfNeeded()
  const wheelBounds = (await header.boundingBox())!
  await page.mouse.move(400, wheelBounds.y + wheelBounds.height / 2)
  await page.keyboard.down("Shift")
  await page.mouse.wheel(0, 180)
  await page.keyboard.up("Shift")
  await expect.poll(scrollLeft).toBeGreaterThan(100)

  await page.getByRole("searchbox", { name: "Search cards" }).fill("no card matches this")
  await expect(page.getByText("No matching cards", { exact: true })).toBeVisible()
  await expect(board).not.toHaveCSS("cursor", "grab")
  await expect(board).toContainText("Try another search")
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(board).toHaveCSS("cursor", "grab")
  await expect.poll(scrollLeft).toBe(0)
})
