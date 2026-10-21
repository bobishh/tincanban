import { expect, test, type Page } from "./support/coverage"

async function createBoard(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title").fill("Focused work")

  await create.getByRole("button", { name: "Create", exact: true }).click()

  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
  await settings.getByText("settings.json", { exact: true }).click()
  const editor = settings.getByLabel("Workspace settings JSON")
  const json = JSON.parse(await editor.inputValue())
  json.board.fields.push({ title: "Owner", valueType: "text", required: false })
  await editor.fill(JSON.stringify(json))
  await settings.getByRole("button", { name: "Apply JSON" }).click()

  for (const [title, status] of [["Launch design", "To do"], ["Launch review", "Doing"], ["Housekeeping", "Done"]]) {
    await page.getByRole("region", { name: status, exact: true }).getByRole("button", { name: `Add item to ${status}` }).click()
    const form = page.getByRole("dialog", { name: "Item details" })
    await form.getByLabel("Title *", { exact: true }).fill(title)
    await form.getByLabel("Body", { exact: true }).fill(`Context for ${title}: decisions and next steps.`)
    await form.getByLabel("Owner", { exact: true }).fill("Alex")
    await form.getByRole("button", { name: "Save item" }).click()
    await expect(form).toBeHidden()
  }
}

test("Given a fresh desktop board, when filtering, searching, and moving a card, then layout and hidden cards persist", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createBoard(page)
  await test.step("Status filter fills desktop width and card exposes context and overview", async () => {
    await page.getByRole("group", { name: "Filters" }).getByRole("combobox", { name: "Status", exact: true }).selectOption({ label: "Doing" })
    await expect(page.locator(".board > .column")).toHaveCount(1)
    const column = page.getByRole("region", { name: "Doing", exact: true })
    await expect(column.locator(".column-header .count")).toHaveText("1")
    expect((await column.boundingBox())!.width).toBeGreaterThan(1250)
    const openCard = column.getByRole("button", { name: "Open Launch review", exact: true })
    const card = openCard.locator("..")
    await expect(card.locator(".card-context").getByText("Context for Launch review: decisions and next steps.")).toBeVisible()
    await expect(card.getByText("Owner", { exact: true })).toBeVisible()
    await expect(card.getByText("Alex", { exact: true })).toBeVisible()
    await page.locator(".board").evaluate((element) => Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {}))))
    await page.screenshot({ path: testInfo.outputPath("single-state.png"), fullPage: true })
    await openCard.click()
    const overview = page.getByRole("dialog", { name: "Item overview" })
    await expect(overview).toBeVisible()
    await expect(overview).toBeFocused()
    await page.keyboard.press("Escape")
    await expect(overview).toHaveCount(0)
    await page.getByRole("button", { name: "Clear search and filters" }).click()
    await expect(page.locator(".board > .column")).toHaveCount(3)
  })

  await test.step("Search keeps two useful columns wide, empty results explain and reset restores cards", async () => {
    const search = page.getByRole("searchbox", { name: "Search cards" })
    await search.fill("Launch")
    await expect(page.locator(".board > .column")).toHaveCount(2)
    for (const column of await page.locator(".board > .column").all()) {
      expect((await column.boundingBox())!.width).toBeGreaterThan(600)
    }
    await search.fill("missing-result")
    await expect(page.locator(".board > .column")).toHaveCount(0)
    await expect(page.getByText("No matching cards", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Clear search and filters" }).click()
    await expect(page.locator(".board > .column")).toHaveCount(3)
    await expect(page.locator(".board .lead-card")).toHaveCount(3)
  })

  await test.step("Filtered drag preview preserves card context geometry", async () => {
    await page.getByRole("searchbox", { name: "Search cards" }).fill("Launch")
    await expect(page.locator(".board > .column")).toHaveCount(2)
    const source = page.getByRole("button", { name: "Open Launch design", exact: true })
    const target = page.getByRole("region", { name: "Doing", exact: true }).locator(".card-stack")
    const from = (await source.boundingBox())!
    const to = (await target.boundingBox())!
    const originalLayout = await source.locator("..").evaluate(card => {
      const main = card.querySelector(".card-main")!.getBoundingClientRect()
      const context = card.querySelector(".card-context")!.getBoundingClientRect()
      return { mainWidth: main.width, contextWidth: context.width, offset: context.x - main.x }
    })
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + to.height - 24, { steps: 18 })
    await expect(target.locator(".lead-card")).toHaveCount(1)
    const preview = page.locator(".board-drag-preview")
    await expect(preview).toBeVisible()
    const previewLayout = await preview.evaluate(card => {
      const bounds = card.getBoundingClientRect()
      const main = card.querySelector(".card-main")!.getBoundingClientRect()
      const context = card.querySelector(".card-context")!.getBoundingClientRect()
      return { mainWidth: main.width, contextWidth: context.width, offset: context.x - main.x,
        opacity: getComputedStyle(card).opacity, contextBottom: context.bottom, cardBottom: bounds.bottom }
    })
    expect(Math.abs(previewLayout.mainWidth - originalLayout.mainWidth)).toBeLessThan(2)
    expect(Math.abs(previewLayout.contextWidth - originalLayout.contextWidth)).toBeLessThan(2)
    expect(Math.abs(previewLayout.offset - originalLayout.offset)).toBeLessThan(2)
    expect(previewLayout.opacity).toBe("1")
    expect(previewLayout.contextBottom).toBeLessThanOrEqual(previewLayout.cardBottom)
    await page.screenshot({ path: testInfo.outputPath("drag-preview.png") })
    await page.mouse.up()
    await expect(page.getByRole("status")).toContainText("Item moved")
  })

  await test.step("Moved card leaves filtered source, hidden card survives reset and reload", async () => {
    await expect(page.locator(".board > .column")).toHaveCount(1)
    await expect(page.getByRole("region", { name: "Doing", exact: true }).locator(".column-header .count")).toHaveText("2")
    await expect(page.getByRole("region", { name: "Doing", exact: true }).getByRole("button", { name: "Open Launch design", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Clear search and filters" }).click()
    await expect(page.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: "Open Housekeeping", exact: true })).toBeVisible()
    await expect(page.locator(".board .lead-card")).toHaveCount(3)
    await page.reload()
    await expect(page.locator(".board > .column")).toHaveCount(3)
    await expect(page.locator(".board .lead-card")).toHaveCount(3)
    await expect(page.getByRole("region", { name: "Doing", exact: true }).getByRole("button", { name: "Open Launch design", exact: true })).toBeVisible()
    await expect(page.getByRole("region", { name: "To do", exact: true }).getByRole("button", { name: "Open Launch design", exact: true })).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: "Open Housekeeping", exact: true })).toBeVisible()
    await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
  })
})

test("Given a mobile status filter, when one column remains then it uses the screen without redundant navigation", async ({ page }, testInfo) => {
  await createBoard(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: /^Filters/ }).click()
  await page.getByRole("group", { name: "Filters" }).getByRole("combobox", { name: "Status", exact: true }).selectOption({ label: "Doing" })
  await expect(page.locator(".board > .column")).toHaveCount(1)
  await expect(page.getByRole("navigation", { name: "Board columns" })).toHaveCount(0)
  await page.locator(".board").evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))))
  const column = await page.locator(".board > .column").boundingBox()
  expect(column!.width).toBeGreaterThanOrEqual(355)
  expect(column!.x + column!.width).toBeLessThanOrEqual(390)
  await expect(page.getByRole("button", { name: "Open Launch review", exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("mobile-single-state.png"), fullPage: true })
  await page.getByRole("searchbox", { name: "Search cards" }).fill("missing-result")
  await expect(page.locator(".board > .column")).toHaveCount(1)
  await expect(page.getByText("No matches in this column", { exact: true })).toBeVisible()
})

test("Given a horizontally scrolled mobile board, when search changes visible columns, then the first matching column returns into view", async ({ page }) => {
  await createBoard(page)
  await page.setViewportSize({ width: 390, height: 844 })
  const board = page.locator(".board")
  await board.evaluate(element => element.scrollTo({ left: element.scrollWidth, behavior: "instant" }))
  await expect.poll(() => board.evaluate(element => element.scrollLeft)).toBeGreaterThan(300)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Launch")
  await expect(page.locator(".board > .column")).toHaveCount(2)
  await expect.poll(() => board.evaluate(element => element.scrollLeft)).toBeLessThan(1)
  await expect(page.getByRole("button", { name: "Open Launch design", exact: true })).toBeInViewport()
})

test("Given filtered cards and a failed save, when dragging ends then the preview disappears and the card returns", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createBoard(page)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Launch")
  await expect(page.locator(".board > .column")).toHaveCount(2)
  await page.evaluate(() => { (window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
  const source = page.getByRole("button", { name: "Open Launch design", exact: true })
  const target = page.getByRole("region", { name: "Doing", exact: true }).locator(".card-stack")
  const from = (await source.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 24, { steps: 18 })
  await expect(page.locator(".board-drag-preview")).toBeVisible()
  await page.mouse.up()
  await expect(page.getByRole("status")).toContainText("Move failed")
  await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
  await expect(page.getByRole("region", { name: "To do", exact: true }).getByRole("button", { name: "Open Launch design", exact: true })).toBeVisible()
  await expect(target.locator(".lead-card")).toHaveCount(1)
})

test("Given a card being dragged, when document data refreshes then drag continues and its ghost disappears on release", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createBoard(page)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Launch")
  await expect(page.locator(".board > .column")).toHaveCount(2)
  const from = (await page.getByRole("button", { name: "Open Launch design", exact: true }).boundingBox())!
  const target = page.getByRole("region", { name: "Doing", exact: true }).locator(".card-stack")
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 24, { steps: 18 })
  await expect(page.locator(".board-drag-preview")).toBeVisible()
  await page.evaluate(async () => {
    const { stateRuntime } = await import("/src/stateContext.ts")
    stateRuntime.docVersion.value++
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
  await expect(page.locator(".board-drag-preview")).toBeVisible()
  await page.mouse.up()
  await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
  await expect(page.getByRole("status")).toContainText("Item moved")
  await expect(target.locator(".lead-card")).toHaveCount(2)
  await page.reload()
  await expect(target.locator(".lead-card")).toHaveCount(2)
})

for (const query of ["Launch design", "Launch review"]) test(`Given a card being dragged, when filtering to ${query} rebuilds the board then drag cancels without leaving a ghost or saving a move`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await createBoard(page)
  const search = page.getByRole("searchbox", { name: "Search cards" })
  await search.fill("Launch")
  await expect(page.locator(".board > .column")).toHaveCount(2)
  const from = (await page.getByRole("button", { name: "Open Launch design", exact: true }).boundingBox())!
  const to = (await page.getByRole("region", { name: "Doing", exact: true }).locator(".card-stack").boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height - 24, { steps: 18 })
  await expect(page.locator(".board-drag-preview")).toBeVisible()
  await search.fill(query)
  await expect(page.locator(".board > .column")).toHaveCount(1)
  await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
  await page.mouse.up()
  await expect(page.getByRole("status")).not.toContainText("Item moved")
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(page.getByRole("region", { name: "To do", exact: true }).getByRole("button", { name: "Open Launch design", exact: true })).toBeVisible()
  await expect(page.locator(".board .lead-card")).toHaveCount(3)
})
