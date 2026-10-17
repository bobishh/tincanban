import { expect, test, type BrowserContext, type Page } from "./support/coverage"

async function createBlankWorkspace(page: Page, title: string) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill(title)
  await dialog.getByRole("radio", { name: "Blank board" }).check()
  await dialog.getByRole("button", { name: "Create" }).click()
}

async function createItem(page: Page, title: string, column: string) {
  await page.getByRole("button", { name: /Add item to/ }).first().click()
  const dialog = page.getByRole("dialog", { name: "Item details" })
  await dialog.getByLabel("Title *").fill(title)
  await dialog.getByLabel("Status *").selectOption({ label: column })
  await dialog.getByRole("button", { name: "Save item" }).click()
  await expect(dialog).toBeHidden()
}

async function setItemBody(page: Page, title: string, body: string) {
  const id = await page.locator(".lead-card").filter({ has: page.getByText(title, { exact: true }) }).getAttribute("data-item-id")
  await page.evaluate(async ({ id, body }) => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    await useTincanban().executeCommandAsync({ kind: "patchItem", entityId: id!, body })
  }, { id, body })
}

async function textSelection(page: Page) {
  return page.evaluate(() => window.getSelection()?.toString() ?? "")
}

async function selectDetailTitle(page: Page, title: string) {
  await page.getByRole("button", { name: `Open ${title}`, exact: true }).click()
  const details = page.getByRole("dialog", { name: "Item overview" })
  const heading = details.getByRole("heading", { name: title, exact: true })
  await expect(heading).toBeVisible()
  const bounds = (await heading.boundingBox())!
  await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2, { steps: 8 })
  await page.mouse.up()
  expect(await textSelection(page)).toContain(title.split(" ")[0])
}

async function settleBoard(page: Page) {
  await expect(page.getByRole("status", { name: "Board status" })).toHaveCount(0)
  await page.locator(".board").evaluate(element => Promise.all(element.getAnimations({ subtree: true })
    .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
    .map(animation => animation.finished.catch(() => {}))))
}

async function drag(page: Page, sourceSelector: string, targetSelector: string) {
  await settleBoard(page)
  const source = page.locator(sourceSelector)
  const target = page.locator(targetSelector)
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error("Drag target missing")
  await page.mouse.move(sourceBox.x + 4, sourceBox.y + 4)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + Math.min(28, targetBox.height / 2), { steps: 12 })
  await page.mouse.up()
}

async function touchDrag(context: BrowserContext, page: Page, sourceSelector: string, targetSelector: string) {
  const source = await page.locator(sourceSelector).boundingBox()
  const target = await page.locator(targetSelector).boundingBox()
  if (!source || !target) throw new Error("Touch drag target missing")
  const session = await context.newCDPSession(page)
  const start = { x: source.x + 4, y: source.y + 4 }
  const end = { x: target.x + target.width / 2, y: target.y + Math.min(40, target.height / 2) }
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] })
  await page.waitForTimeout(220)
  for (let step = 1; step <= 24; step++) {
    const ratio = step / 24
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
      x: start.x + (end.x - start.x) * ratio,
      y: start.y + (end.y - start.y) * ratio,
    }] })
    await page.waitForTimeout(20)
  }
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
}

test.describe("Trello-like board dragging", () => {
  test("Given a detailed card, when dragging then cancelling or dropping, then the full card follows the grab point and a quiet gap clears", async ({ page }, testInfo) => {
    await createBlankWorkspace(page, "Full card drag preview")
    await createItem(page, "Drag this entire card", "To do")
    await createItem(page, "Destination neighbor", "Doing")
    await setItemBody(page, "Drag this entire card", "**Visible detail** with a second line.\n\n- [ ] Keep this task")
    await settleBoard(page)
    const source = page.locator('.lead-card[data-item-id]:has-text("Drag this entire card")')
    await expect(source.locator(".markdown-content strong")).toHaveText("Visible detail")
    const neighbor = page.locator('.lead-card[data-item-id]:has-text("Destination neighbor")')
    const original = (await source.boundingBox())!
    const destination = (await neighbor.boundingBox())!
    const text = await source.innerText()
    const appearance = await source.evaluate(card => ({
      border: getComputedStyle(card).borderImageSource,
      fill: getComputedStyle(card, "::before").backgroundImage,
    }))
    for (const outcome of ["cancel", "drop"]) {
      await page.mouse.move(original.x + 4, original.y + 4)
      await page.mouse.down()
      const point = { x: destination.x + destination.width / 2, y: destination.y + 5 }
      await page.mouse.move(point.x, point.y, { steps: 16 })
      const preview = page.locator(".board-drag-preview")
      await expect(preview).toBeVisible()
      await expect(preview).toHaveText(text, { useInnerText: true })
      await expect(page.locator(".board-drop-marker")).toHaveCount(0)
      await expect(neighbor).toHaveClass(/board-drop-gap/)
      expect((await neighbor.boundingBox())!.y - destination.y).toBeCloseTo(32, 0)
      await expect(source).toHaveCSS("visibility", "hidden")
      await expect.poll(async () => {
        const box = (await preview.boundingBox())!
        return Math.abs(box.x - (point.x - 4)) + Math.abs(box.y - (point.y - 4))
      }).toBeLessThan(2)
      const box = (await preview.boundingBox())!
      expect(box.width).toBeCloseTo(original.width, 0)
      expect(box.height).toBeCloseTo(original.height, 0)
      await expect(preview).toHaveCSS("opacity", "1")
      expect(await preview.locator(".lead-card").evaluate(card => ({
        border: getComputedStyle(card).borderImageSource,
        fill: getComputedStyle(card, "::before").backgroundImage,
      }))).toEqual(appearance)
      // A second pointer position must move the same card without moving the insertion gap.
      await page.mouse.move(point.x + 20, point.y + 10)
      await expect.poll(async () => (await preview.boundingBox())!.x).toBeCloseTo(box.x + 20, 0)
      expect((await neighbor.boundingBox())!.y - destination.y).toBeCloseTo(32, 0)
      if (outcome === "cancel") {
        await page.screenshot({ path: testInfo.outputPath("full-card-drag.png") })
        await page.keyboard.press("Escape")
      }
      await page.mouse.up()
      await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
      await expect(source).toHaveCSS("visibility", "visible")
      await expect(source).toHaveCSS("opacity", "1")
      await expect(page.getByRole("region", { name: outcome === "cancel" ? "To do" : "Doing", exact: true }).locator(".card-main > strong"))
        .toHaveText(outcome === "cancel" ? ["Drag this entire card"] : ["Drag this entire card", "Destination neighbor"])
      if (outcome === "drop") await expect(page.getByRole("status")).toContainText("Item moved")
    }
    await page.reload()
    await expect(page.getByRole("region", { name: "Doing", exact: true }).locator(".card-main > strong"))
      .toHaveText(["Drag this entire card", "Destination neighbor"])
  })

  test("Given detailed card text across columns, when dragging from card border, then selection stays empty and card moves", async ({ page }) => {
    await createBlankWorkspace(page, "Drag selection arbitration")
    await createItem(page, "Border dragged card", "To do")
    await createItem(page, "Target card", "Doing")
    await setItemBody(page, "Border dragged card", "A long detail line to cross while moving. ".repeat(8))
    await setItemBody(page, "Target card", "Existing target detail.")
    const source = await page.locator('.lead-card:has-text("Border dragged card")').boundingBox()
    const target = await page.locator('.lead-card:has-text("Target card")').boundingBox()
    if (!source || !target) throw new Error("Card drag points missing")
    await page.mouse.move(source.x + 4, source.y + 4)
    await page.mouse.down()
    await page.mouse.move(source.x + 5, source.y + 4)
    await expect(page.locator(".board")).toHaveClass(/board-drag-pending/)
    expect(await page.locator(".board-drag-pending .card-main").first().evaluate(element => getComputedStyle(element).userSelect)).toBe("none")
    expect(await textSelection(page)).toBe("")
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 18 })
    await expect(page.locator(".board-drag-preview")).toBeVisible()
    await expect(page.locator(".board-drop-gap")).toHaveAttribute("data-target-id", await page.getByRole("region", { name: "Doing", exact: true }).getAttribute("data-column-id"))
    expect(await page.locator(".board-dragging .card-main").first().evaluate(element => getComputedStyle(element).userSelect)).toBe("none")
    expect(await textSelection(page)).toBe("")
    await page.mouse.up()
    await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Border dragged card", { exact: true })).toBeVisible()
    expect(await textSelection(page)).toBe("")
  })

  test("Given board title text, when dragging it into another column, then the full card moves without selecting text or opening details", async ({ page }) => {
    await createBlankWorkspace(page, "Title drag arbitration")
    await createItem(page, "Drag from title", "To do")
    const title = page.getByText("Drag from title", { exact: true })
    const bounds = (await title.boundingBox())!
    const destination = (await page.getByRole("region", { name: "Doing", exact: true }).locator(".card-stack").boundingBox())!
    await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(destination.x + destination.width / 2, destination.y + 100, { steps: 12 })
    await expect(page.locator(".board-drag-preview")).toContainText("Drag from title")
    expect(await textSelection(page)).toBe("")
    await expect(page.getByRole("button", { name: "Discuss selection", exact: true })).toHaveCount(0)
    await page.mouse.up()
    await expect(page.getByRole("status")).toContainText("Item moved")
    await expect(page.getByRole("dialog", { name: "Item overview" })).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Drag from title", { exact: true })).toBeVisible()
    await selectDetailTitle(page, "Drag from title")
    await expect(page.getByRole("button", { name: "Discuss selection", exact: true })).toBeVisible()
  })

  test("Given an active border drag, when Escape cancels, then drag clears and text selection still works inside details", async ({ page }) => {
    await createBlankWorkspace(page, "Escape drag selection")
    await createItem(page, "Escape source", "To do")
    const source = await page.locator('.lead-card:has-text("Escape source")').boundingBox()
    const target = await page.getByRole("region", { name: "Doing", exact: true }).locator(".card-stack").boundingBox()
    if (!source || !target) throw new Error("Card drag points missing")
    await page.mouse.move(source.x + 4, source.y + 4)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width / 2, target.y + 100, { steps: 12 })
    await expect(page.locator(".board-drag-preview")).toBeVisible()
    await page.keyboard.press("Escape")
    await page.mouse.up()
    await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
    await expect(page.locator(".board")).not.toHaveClass(/board-drag/)
    await expect(page.getByRole("region", { name: "To do", exact: true }).getByText("Escape source", { exact: true })).toBeVisible()
    expect(await textSelection(page)).toBe("")
    await selectDetailTitle(page, "Escape source")
  })

  test("Given an active border drag, when pointercancel fires, then no move commits and details remain selectable", async ({ page }) => {
    await createBlankWorkspace(page, "Pointer cancel drag selection")
    await createItem(page, "Pointer cancel source", "To do")
    const source = await page.locator('.lead-card:has-text("Pointer cancel source")').boundingBox()
    const target = await page.getByRole("region", { name: "Doing", exact: true }).locator(".card-stack").boundingBox()
    if (!source || !target) throw new Error("Card drag points missing")
    await page.mouse.move(source.x + 4, source.y + 4)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width / 2, target.y + 100, { steps: 12 })
    await expect(page.locator(".board-drag-preview")).toBeVisible()
    await page.evaluate(() => document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })))
    await page.mouse.up()
    await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
    await expect(page.locator(".board")).not.toHaveClass(/board-drag/)
    await expect(page.getByRole("region", { name: "To do", exact: true }).getByText("Pointer cancel source", { exact: true })).toBeVisible()
    expect(await textSelection(page)).toBe("")
    await selectDetailTitle(page, "Pointer cancel source")
  })

  test("Given filtered cards with a hidden neighbor, when dropping at the unchanged visible position, then hidden order and document revision stay unchanged", async ({ page }) => {
    await createBlankWorkspace(page, "Filtered no-op board")
    for (const title of ["Shown First", "Hidden", "Shown Second"]) await createItem(page, title, "To do")
    const search = page.getByRole("searchbox", { name: "Search cards" })
    await search.fill("Shown")
    await expect(page.locator(".board .lead-card")).toHaveCount(2)
    const initial = await page.evaluate(async () => (await import("/src/stateContext.ts")).stateRuntime.docVersion.value)
    const source = (await page.getByRole("button", { name: "Open Shown First", exact: true }).boundingBox())!
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 3 })
    await expect(page.locator(".board-drag-preview")).toBeVisible()
    await page.mouse.up()
    await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
    expect(await page.evaluate(async () => (await import("/src/stateContext.ts")).stateRuntime.docVersion.value)).toBe(initial)
    await search.fill("")
    await expect(page.getByRole("region", { name: "To do", exact: true }).locator(".card-main > strong")).toHaveText(["Shown First", "Hidden", "Shown Second"])
  })

  test("Given an unchanged card order, when cancelling a drag or dropping at its original position, then no document write occurs", async ({ page }) => {
    await createBlankWorkspace(page, "Cancelled drag board")
    await createItem(page, "First", "To do")
    await createItem(page, "Second", "To do")
    const revision = () => page.evaluate(async () => (await import("/src/stateContext.ts")).stateRuntime.docVersion.value)
    const initial = await revision()
    const card = page.getByRole("button", { name: "Open First", exact: true })
    const source = (await card.boundingBox())!
    const target = (await page.getByRole("region", { name: "Doing", exact: true }).boundingBox())!
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width / 2, target.y + 100, { steps: 12 })
    await expect(page.locator(".board-drag-preview")).toBeVisible()
    await page.keyboard.press("Escape")
    await page.mouse.up()
    await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
    expect(await revision()).toBe(initial)
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
    await page.mouse.down()
    await page.mouse.move(source.x + source.width / 2 + 12, source.y + source.height / 2, { steps: 3 })
    await expect(page.locator(".board-drag-preview")).toBeVisible()
    await page.mouse.up()
    await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
    expect(await revision()).toBe(initial)
    await expect(page.getByRole("region", { name: "To do", exact: true }).locator(".card-main > strong")).toHaveText(["First", "Second"])
    await card.click()
    await expect(page.getByRole("dialog", { name: "Item overview" })).toBeVisible()
  })

  test("Given a card and its neighbor, when dragged before the neighbor, then source stays in Vue DOM and separate preview marks one persisted move", async ({ page }) => {
    await createBlankWorkspace(page, "Stable drag board")
    await createItem(page, "Keep here", "To do")
    await createItem(page, "Neighbor", "To do")
    const source = page.locator('.lead-card[data-item-id]:has-text("Neighbor")')
    await page.evaluate(async () => {
      const { stateRuntime } = await import("/src/stateContext.ts")
      const workspaceId = stateRuntime.activeDoc?.id
      if (!workspaceId) throw new Error("Workspace is unavailable")
      const changes = ((window as any).__dragPersistedCommands = { workspaceId, count: 0 })
      const listener = (changedWorkspaceId?: string) => {
        if (changedWorkspaceId === workspaceId) changes.count += 1
      }
      changes.listener = listener
      stateRuntime.localChangeListeners.add(listener)
    })
    await source.evaluate(element => Object.assign(window, { __dragSourceNode: element, __dragSourceParent: element.parentElement, __dragSourceNext: element.nextElementSibling }))
    const sourceBox = (await source.boundingBox())!
    const neighborBox = (await page.locator('.lead-card[data-item-id]:has-text("Keep here")').boundingBox())!
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(neighborBox.x + neighborBox.width / 2, neighborBox.y + 5, { steps: 12 })
    await expect(page.locator(".board-drag-preview")).toBeVisible()
    await expect(page.locator(".board-drop-gap")).toHaveAttribute("data-before-id", /.+/)
    const insertionGap = await page.locator(".board-drop-gap").evaluate(element => Number.parseFloat(getComputedStyle(element).marginTop))
    const sourceBounds = await source.evaluate(element => ({ width: element.getBoundingClientRect().width }))
    expect(insertionGap).toBe(32)
    await expect(page.locator(".board-drop-marker")).toHaveCount(0)
    expect(sourceBounds?.width).toBeGreaterThan(100)
    const sourceStillOwned = await source.evaluate(element => element === (window as any).__dragSourceNode && element.parentElement === (window as any).__dragSourceParent && element.nextElementSibling === (window as any).__dragSourceNext)
    expect(sourceStillOwned).toBe(true)
    await page.mouse.up()
    await expect(page.getByRole("region", { name: "To do", exact: true }).locator(".card-main > strong")).toHaveText(["Neighbor", "Keep here"])
    await expect(page.getByRole("status")).toContainText("Item moved")
    await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => {
      const { stateRuntime } = await import("/src/stateContext.ts")
      return (window as any).__dragPersistedCommands.count
    })).toBe(1)
    await page.reload()
    await expect(page.getByRole("region", { name: "To do", exact: true }).locator(".card-main > strong")).toHaveText(["Neighbor", "Keep here"])
    await page.evaluate(async () => {
      const { stateRuntime } = await import("/src/stateContext.ts")
      const changes = (window as any).__dragPersistedCommands
      if (changes?.listener) stateRuntime.localChangeListeners.delete(changes.listener)
    })
  })

  test("Given an independent header selection, when a card border drag completes, then that selection remains intact", async ({ page }) => {
    await createBlankWorkspace(page, "Preserved independent selection")
    await createItem(page, "Preserve this selection", "To do")
    await createItem(page, "Selection drop target", "Doing")
    const title = page.locator(".topbar .workspace-heading")
    await title.evaluate(element => {
      const text = element.firstChild
      if (!text) throw new Error("Card title text missing")
      const selection = document.getSelection()!
      selection.setBaseAndExtent(text, 0, text, Math.min(12, text.textContent?.length ?? 0))
    })
    const selected = await textSelection(page)
    const source = (await page.locator('.lead-card:has-text("Preserve this selection")').boundingBox())!
    const target = (await page.locator('.lead-card:has-text("Selection drop target")').boundingBox())!
    await page.mouse.move(source.x + 4, source.y + 4)
    await page.mouse.down()
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 18 })
    await expect(page.locator(".board-drag-preview")).toBeVisible()
    await page.mouse.up()
    expect(await textSelection(page)).toBe(selected)
  })

  test("Given a mobile card stack, when a finger swipes immediately, then the board scroll gesture does not reorder cards", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 640 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    try {
      await createBlankWorkspace(page, "Mobile scroll board")
      await createItem(page, "First", "To do")
      await createItem(page, "Second", "To do")
      const second = await page.locator('.lead-card[data-item-id]:has-text("Second")').boundingBox()
      if (!second) throw new Error("Touch source missing")
      const session = await context.newCDPSession(page)
      const start = { x: second.x + second.width / 2, y: second.y + second.height / 2 }
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] })
      for (let step = 1; step <= 8; step += 1) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: start.x, y: start.y - step * 14 }],
        })
        await page.waitForTimeout(10)
      }
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })

      const cards = page.getByRole("region", { name: "To do" }).locator(".lead-card")
      await expect(cards.nth(0)).toContainText("First")
      await expect(cards.nth(1)).toContainText("Second")
      await expect(page.getByText("Item moved", { exact: true })).toHaveCount(0)
    } finally { await context.close() }
  })

  test("Given a mobile board, when an editor drags a card sideways, then the board scrolls and the card changes column", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    try {
      await createBlankWorkspace(page, "Mobile drag board")
      await createItem(page, "Touch me", "To do")
      await touchDrag(context, page, '.lead-card[data-item-id]:has-text("Touch me")', '[role="region"][aria-label="Doing"] .card-stack')

      await expect(page.getByRole("region", { name: "Doing" }).getByText("Touch me")).toBeVisible()
      await expect(page.getByRole("status")).toContainText("Item moved")
      await page.reload()
      await expect(page.getByRole("region", { name: "Doing" }).getByText("Touch me")).toBeVisible()
    } finally { await context.close() }
  })

  test("Given a mobile board, when a card is released over another column header, then that column receives it", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    try {
      await createBlankWorkspace(page, "Mobile column drop board")
      await createItem(page, "Drop on column", "To do")
      await touchDrag(context, page, '.lead-card[data-item-id]:has-text("Drop on column")', '[role="region"][aria-label="Doing"] .column-header')

      await expect(page.getByRole("region", { name: "Doing" }).getByText("Drop on column")).toBeVisible()
      await expect(page.getByRole("status")).toContainText("Item moved")
    } finally { await context.close() }
  })

  test("Given three cards, when cards and columns reorder, then hints, neighbors and exact order survive reload", async ({ page }) => {
    await createBlankWorkspace(page, "Ordering story")
    for (const title of ["First", "Second", "Third"]) await createItem(page, title, "To do")
    const titles = (column: string) => page.getByRole("region", { name: column, exact: true }).locator(".card-main > strong")
    const expectOrder = async () => {
      await expect(titles("To do")).toHaveText(["Third", "First"])
      await expect(titles("Doing")).toHaveText(["Second"])
      await expect(titles("Done")).toHaveCount(0)
    }

    await test.step("Hover and drop into an empty column", async () => {
      await settleBoard(page)
      await page.evaluate(() => window.scrollTo(0, 0))
      const target = page.getByRole("region", { name: "Doing", exact: true }).locator(".card-stack")
      await expect(target.getByText("No items", { exact: true })).toBeVisible()
      const source = await page.locator('.lead-card[data-item-id]:has-text("Third")').boundingBox()
      const box = await target.boundingBox()
      if (!source || !box) throw new Error("Missing drag bounds")
      await page.mouse.move(source.x + 4, source.y + 4)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2, box.y + 28, { steps: 20 })
      await expect(target.locator(".empty-column")).toBeVisible()
      await expect(page.locator(".board-drop-gap")).toHaveAttribute("data-target-id", await target.getAttribute("data-column-id"))
      await page.mouse.up()
      await expect(page.getByRole("status")).toContainText("Item moved")
      await expect(titles("Doing")).toHaveText(["Third"])
      await expect(titles("To do")).toHaveText(["First", "Second"])
      await page.reload()
      await expect(titles("Doing")).toHaveText(["Third"])
      await expect(titles("To do")).toHaveText(["First", "Second"])
    })

    await test.step("Insert before another card and preserve the full order", async () => {
      await settleBoard(page)
      const source = await page.locator('.lead-card[data-item-id]:has-text("Third")').boundingBox()
      const target = await page.locator('.lead-card[data-item-id]:has-text("First")').boundingBox()
      if (!source || !target) throw new Error("Card drag target missing")
      await page.mouse.move(source.x + 4, source.y + 4)
      await page.mouse.down()
      await page.mouse.move(target.x + target.width / 2, target.y + 5, { steps: 16 })
      await page.mouse.up()
      await expect(page.getByRole("status")).toContainText("Item moved")
      await expect(titles("To do")).toHaveText(["Third", "First", "Second"])
      await expect(titles("Doing")).toHaveCount(0)
      // Exercise same-column ordering as well as the cross-column insertion.
      await drag(page, '.lead-card[data-item-id]:has-text("Second")', '[role="region"][aria-label="Doing"] .card-stack')
      await expectOrder()
      await settleBoard(page)
      const third = await page.locator('.lead-card[data-item-id]:has-text("Third")').boundingBox()
      const first = await page.locator('.lead-card[data-item-id]:has-text("First")').boundingBox()
      if (!third || !first) throw new Error("Same-column drag target missing")
      await page.mouse.move(first.x + 4, first.y + 4)
      await page.mouse.down()
      await page.mouse.move(third.x + third.width / 2, third.y + 5, { steps: 16 })
      await page.mouse.up()
      await expect(titles("To do")).toHaveText(["First", "Third"])
      await expect(titles("Doing")).toHaveText(["Second"])
    })

    await test.step("Reorder columns and reopen durable card and column order", async () => {
      await settleBoard(page)
      await page.getByRole("button", { name: "Edit board" }).click()
      const source = await page.locator('[role="region"][aria-label="Done"] .column-header').boundingBox()
      const target = await page.locator('[role="region"][aria-label="To do"] .column-header').boundingBox()
      if (!source || !target) throw new Error("Column drag target missing")
      await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
      await page.mouse.down()
      await page.mouse.move(target.x + 8, target.y + target.height / 2, { steps: 20 })
      await page.mouse.up()
      await expect(page.getByRole("status")).toContainText("Column moved")
      const columns = page.locator(".board > .column")
      await expect(columns).toHaveCount(3)
      await expect(columns.nth(0)).toHaveAttribute("aria-label", "Done")
      await expect(columns.nth(1)).toHaveAttribute("aria-label", "To do")
      await expect(columns.nth(2)).toHaveAttribute("aria-label", "Doing")
      await page.reload()
      await expect(columns.nth(0)).toHaveAttribute("aria-label", "Done")
      await expect(columns.nth(1)).toHaveAttribute("aria-label", "To do")
      await expect(columns.nth(2)).toHaveAttribute("aria-label", "Doing")
      await expect(titles("To do")).toHaveText(["First", "Third"])
      await expect(titles("Doing")).toHaveText(["Second"])
      await expect(titles("Done")).toHaveCount(0)
    })
  })

  test("Given persistence fails, when a card is dragged and retried, then rollback and recovery preserve neighbors after reload", async ({ page }) => {
    await createBlankWorkspace(page, "Failed drag board")
    await createItem(page, "Keep here", "To do")
    await createItem(page, "Neighbor", "To do")
    await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
    await drag(page, '.lead-card[data-item-id]:has-text("Keep here")', '[role="region"][aria-label="Doing"] .card-stack')
    await expect(page.getByRole("status")).toContainText("Move failed")
    const source = page.getByRole("region", { name: "To do", exact: true }).locator(".card-main > strong")
    await expect(source).toHaveText(["Keep here", "Neighbor"])
    await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("No items", { exact: true })).toBeVisible()
    await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
    await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })
    await drag(page, '.lead-card[data-item-id]:has-text("Keep here")', '[role="region"][aria-label="Doing"] .card-stack')
    await expect(page.getByRole("status")).toContainText("Item moved")
    await page.reload()
    await expect(source).toHaveText(["Neighbor"])
    await expect(page.getByRole("region", { name: "Doing", exact: true }).locator(".card-main > strong")).toHaveText(["Keep here"])
  })

  test("Given storage rejects a card move, when rollback finishes, then card details remain selectable", async ({ page }) => {
    await createBlankWorkspace(page, "Failed drag selection recovery")
    await createItem(page, "Selectable after rollback", "To do")
    await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
    await drag(page, '.lead-card[data-item-id]:has-text("Selectable after rollback")', '[role="region"][aria-label="Doing"] .card-stack')
    await expect(page.getByRole("status")).toContainText("Move failed")
    await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
    await expect(page.getByRole("region", { name: "To do", exact: true }).getByText("Selectable after rollback", { exact: true })).toBeVisible()
    expect(await textSelection(page)).toBe("")
    await selectDetailTitle(page, "Selectable after rollback")
  })
})
