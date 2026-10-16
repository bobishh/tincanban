import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given a job-search board, when archive opens with Enter and closes at four widths, then columns retain geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const archive = page.getByRole("region", { name: "Archive", exact: true })
  await expect(archive).toBeAttached()

  async function expectSingleRow() {
    await expect.poll(async () => {
      const boxes = await page.locator(".board > .column").evaluateAll((columns) =>
        columns.map((column) => {
          const box = column.getBoundingClientRect()
          return { top: box.top, left: box.left, width: box.width }
        }),
      )
      return boxes.length === 6 && boxes.every((box, index) =>
        Math.abs(box.top - boxes[0]!.top) < 1 &&
        (index === 0 || box.left > boxes[index - 1]!.left) &&
        (index === boxes.length - 1 || box.width >= 200),
      )
    }).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  }

  for (const width of [1920, 1440, 1024, 390]) {
    await test.step(`${width}px: expand, inspect, and collapse archive`, async () => {
      await page.setViewportSize({ width, height: 900 })
      await expectSingleRow()
      const openArchive = archive.getByRole("button", { name: "Open archive with 0 cards" })
      await openArchive.focus()
      await page.keyboard.press("Enter")
      await expect(archive.getByText("No leads")).toBeVisible()
      await expect(archive.locator('.column-header')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(archive.locator('.column-header')).toHaveCSS('color', 'rgb(23, 23, 23)')
      await expectSingleRow()
      await expect.poll(async () => {
        const archiveBox = await archive.boundingBox()
        const regularBox = await page.getByRole("region", { name: "Lead", exact: true }).boundingBox()
        return Math.abs(archiveBox!.width - regularBox!.width)
      }).toBeLessThan(1)
      await archive.getByRole("button", { name: "Collapse archive" }).click()
      await expectSingleRow()
      await expect.poll(async () => (await archive.boundingBox())!.width).toBe(64)
    })
  }
})

test("Given collapsible Rejected and Archive columns, when each is toggled, then their local states stay independent", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const rejected = page.getByRole("region", { name: "Rejected", exact: true })
  const archive = page.getByRole("region", { name: "Archive", exact: true })
  await rejected.getByRole("button", { name: "Collapse Rejected" }).click()
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect.poll(() => rejected.evaluate(element => getComputedStyle(element, "::before").content)).toBe("none")
  await expect(archive.getByRole("button", { name: "Open Archive with 0 cards" })).toBeVisible()
  await expect(archive.getByRole("button", { name: "Open Archive with 0 cards" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect.poll(() => archive.evaluate(element => getComputedStyle(element, "::before").content)).toBe("none")
  await archive.getByRole("button", { name: "Open Archive with 0 cards" }).click()
  await expect(archive.getByText("No leads")).toBeVisible()
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("region", { name: "Rejected", exact: true }).getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
})

test("Given a collapsible column on desktop or mobile, when it closes and reopens, then width animates both ways", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const rejected = page.getByRole("region", { name: "Rejected", exact: true })
  const width = async () => (await rejected.boundingBox())!.width

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport)
    await rejected.scrollIntoViewIfNeeded()
    const collapse = rejected.getByRole("button", { name: "Collapse Rejected" })
    await expect(collapse).toBeVisible()
    const expandedWidth = await width()
    await collapse.click()
    await page.waitForTimeout(180)
    const closingWidth = await width()
    expect(closingWidth).toBeGreaterThan(80)
    expect(closingWidth).toBeLessThan(expandedWidth - 8)
    await expect.poll(width).toBe(64)

    const open = rejected.getByRole("button", { name: /Open Rejected with/ })
    await open.click()
    await page.waitForTimeout(180)
    const openingWidth = await width()
    expect(openingWidth).toBeGreaterThan(84)
    expect(openingWidth).toBeLessThan(expandedWidth - 8)
    await expect.poll(width).toBeGreaterThan(200)
  }
})

test("Given archive role moves, when the board updates, then old preset bindings do not keep old column styled as Archive", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const oldArchive = page.getByRole("region", { name: "Archive", exact: true })
  const nextArchive = page.getByRole("region", { name: "Rejected", exact: true })
  await expect(oldArchive).toHaveClass(/column-archived/)

  await page.evaluate(async () => {
    const { useTincanban } = await import("/src/state.ts")
    const { projectWorkspaceSettings } = await import("/src/domain/workspaceSettings.ts")
    const tincanban = useTincanban()
    const doc = tincanban.getActiveDoc()
    if (!doc) throw new Error("Workspace document unavailable")
    const settings = projectWorkspaceSettings(doc)
    const old = settings.board.columns.find(column => column.archive)
    const next = settings.board.columns.find(column => column.title === "Rejected")
    if (!old || !next) throw new Error("Expected old and new Archive columns")
    delete old.archive
    next.archive = true
    await tincanban.executeCommandAsync({ kind: "updateWorkspaceSettings", settings })
  })

  await expect(oldArchive).not.toHaveClass(/column-archived|bin-column/)
  await expect(nextArchive).toHaveClass(/bin-column/)
  await expect(nextArchive).toHaveClass(/column-rejected/)
  await nextArchive.getByRole("button", { name: "Open Rejected with 0 cards" }).click()
  await expect(nextArchive).toHaveClass(/bin-column-open/)
})

test("Given invalid local collapse preferences, when the board loads, then preferences recover and collapse controls remain usable", async ({ page }) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem
    Storage.prototype.getItem = function (key: string) {
      return key.startsWith("tincanban:collapsed-columns:") ? "{" : getItem.call(this, key)
    }
  })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const rejected = page.getByRole("region", { name: "Rejected", exact: true })
  await expect(rejected.getByRole("button", { name: "Collapse Rejected" })).toBeVisible()
  await rejected.getByRole("button", { name: "Collapse Rejected" }).click()
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
})


test.describe("Folded board motion", () => {

  test("Given a folded board, when opened, then paper appears before contents and reduced motion opens immediately", async ({ page }, info) => {
    await page.setViewportSize({ width: 1920, height: 900 })
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    const archive = page.getByRole("region", { name: "Archive", exact: true })
    await archive.getByRole("button", { name: /Open Archive with/ }).scrollIntoViewIfNeeded()
    await page.waitForTimeout(600)
    const ink = await archive.locator(".column-fold-cover").evaluate(element => getComputedStyle(element, "::before").backgroundColor)
    const frames = await archive.evaluate(async element => {
      const open = element.querySelector<HTMLButtonElement>(".column-closed")!
      const samples: { time: number; width: number; paper: number; contents: number; spineInk?: string; headerInk?: string }[] = []
      open.click()
      const start = performance.now()
      await new Promise<void>(resolve => {
        function sample() {
          const time = performance.now() - start
          const contents = element.querySelector(".card-stack")
          const mark = element.querySelector(".column-fold-cover")
          const header = element.querySelector(".column-header")
          samples.push({ time, width: element.getBoundingClientRect().width,
            paper: Number(getComputedStyle(element.querySelector(".column-paper")!).opacity),
            contents: contents ? Number(getComputedStyle(contents).opacity) : 0,
            spineInk: mark ? getComputedStyle(mark, "::before").backgroundColor : undefined,
            headerInk: header ? getComputedStyle(header, "::before").backgroundColor : undefined })
          if (time < 650) requestAnimationFrame(sample)
          else resolve()
        }
        requestAnimationFrame(sample)
      })
      return samples
    })
    expect(frames.filter(frame => frame.spineInk).every(frame => frame.spineInk === ink)).toBe(true)
    expect(frames.filter(frame => frame.headerInk).every(frame => frame.headerInk === ink)).toBe(true)
    const early = frames.find(frame => frame.time >= 180)!
    const paper = frames.find(frame => frame.time >= 180)!
    expect(early.width).toBeGreaterThan(64)
    expect(early.contents).toBe(0)
    expect(paper.paper).toBeGreaterThan(0)
    expect(paper.contents).toBe(0)
    expect(frames.at(-1)!.contents).toBe(1)
    await expect(archive.getByText("No leads", { exact: true })).toBeVisible()
    await page.waitForTimeout(700)
    await archive.getByRole("button", { name: "Collapse Archive", exact: true }).click()
    await expect.poll(async () => (await archive.boundingBox())!.width).toBe(64)
    await page.waitForTimeout(600)
    await expect.poll(() => archive.locator(".column-fold-cover").evaluate(element => getComputedStyle(element, "::before").backgroundColor)).toBe(ink)
    await expect.poll(() => archive.locator(".column-fold-cover").evaluate(element => getComputedStyle(element, "::before").opacity)).toBe("0.58")
    await expect(archive).toHaveCSS("border-top-width", "2px")
    await expect(archive).toHaveCSS("border-bottom-width", "2px")
    await expect(archive).toHaveCSS("border-image-source", "none")
    await page.screenshot({ path: info.outputPath("folded-board.png") })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await archive.getByRole("button", { name: /Open Archive with/ }).click()
    await expect(archive.locator(".card-stack")).toHaveCSS("opacity", "1")
    await expect(archive.locator(".column-paper")).toHaveCSS("opacity", "1")
  })
})


test("Given a board taller than the viewport, when Rejected and Archive fold, then their labels and counts remain visible near the board top", async ({ page }, info) => {
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.evaluate(async () => {
    const { useTincanban } = await import("/src/state.ts")
    const app = useTincanban()
    await app.whenReady()
    const columns = Object.values(app.getActiveDoc()!.entities).filter(entity => entity.kind === "column")
    for (const [title, count] of [["Lead", 18], ["Rejected", 1], ["Archive", 1]] as const) {
      const parentId = columns.find(column => column.title === (title === "Archive" ? "Lead" : title))!.id
      for (let index = 0; index < count; index++) {
        const id = crypto.randomUUID()
        await app.executeCommandAsync({ kind: "createItem", id, parentId, title: `${title} card ${index + 1}` })
        if (title === "Archive") await app.executeCommandAsync({ kind: "setEntityArchived", entityId: id, archived: true })
      }
    }
  })
  const rejected = page.getByRole("region", { name: "Rejected", exact: true })
  const archive = page.getByRole("region", { name: "Archive", exact: true })
  await rejected.getByRole("button", { name: "Collapse Rejected", exact: true }).click()
  await expect.poll(async () => (await rejected.boundingBox())!.width).toBe(64)
  await page.evaluate(() => scrollTo(0, 0))
  expect((await page.getByRole("region", { name: "Lead", exact: true }).boundingBox())!.height).toBeGreaterThan(1800)
  for (const column of [rejected, archive]) {
    await expect(column.locator(".column-closed strong")).toBeInViewport({ ratio: 1 })
    await expect(column.locator(".column-closed .count")).toHaveText("1")
    await expect(column.locator(".column-closed .count")).toBeInViewport({ ratio: 1 })
    await expect.poll(() => column.locator(".column-fold-cover").evaluate(element => getComputedStyle(element, "::before").opacity)).toBe("0.58")
  }
  await page.screenshot({ path: info.outputPath("tall-board-folded-labels.png") })
  await archive.getByRole("button", { name: "Open Archive with 1 cards", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(archive.locator(".lead-card").filter({ hasText: "Archive card 1" })).toBeVisible()
})

test("Given an open column, when folded and unfolded, then its striped header turns and stretches into a full-height spine", async ({ page }, info) => {
  await page.setViewportSize({ width: 1920, height: 900 })
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const column = page.getByRole("region", { name: "Rejected", exact: true })
  const frames = await column.evaluate(async element => {
    element.querySelector<HTMLButtonElement>(".bin-close")!.click()
    const start = performance.now()
    const samples: { time: number; angle: number; length: number; visible: boolean; opacity: number }[] = []
    await new Promise<void>(resolve => {
      function sample() {
        const cover = element.querySelector(".column-fold-cover")
        const style = cover && getComputedStyle(cover)
        const matrix = new DOMMatrix(style?.transform)
        samples.push({ time: performance.now() - start, angle: Math.atan2(matrix.b, matrix.a) * 180 / Math.PI,
          length: parseFloat(style?.width || "0"), visible: style?.visibility === "visible", opacity: Number(style?.opacity) })
        if (performance.now() - start < 650) requestAnimationFrame(sample)
        else resolve()
      }
      requestAnimationFrame(sample)
    })
    return samples
  })
  expect(frames.every(frame => frame.visible && frame.opacity === 1)).toBe(true)
  const turning = frames.filter(frame => frame.visible && frame.angle > 5 && frame.angle < 85)
  expect(turning.length).toBeGreaterThan(1)
  const stretched = frames.filter(frame => frame.visible && frame.angle >= 85)
  expect(stretched.length).toBeGreaterThan(1)
  expect(stretched.at(-1)!.length).toBeGreaterThan(turning[0]!.length + 80)
  await expect(column.getByRole("button", { name: /Open Rejected with/ })).toBeVisible()
  await page.screenshot({ path: info.outputPath("full-height-striped-spine.png") })
  await column.getByRole("button", { name: /Open Rejected with/ }).click()
  await expect(column.locator(".column-fold-cover")).toHaveCSS("visibility", "visible")
  await expect(column.getByText("No leads", { exact: true })).toBeVisible()
  await expect.poll(() => column.locator(".column-fold-cover").evaluate(element => element.getAnimations().length)).toBe(0)
  const reversal = await column.evaluate(async element => {
    element.querySelector<HTMLButtonElement>(".bin-close")!.click()
    await new Promise(resolve => setTimeout(resolve, 90))
    const cover = element.querySelector(".column-fold-cover")!
    const before = getComputedStyle(cover).transform
    element.querySelector<HTMLButtonElement>(".column-closed")!.click()
    await new Promise(requestAnimationFrame)
    const style = getComputedStyle(cover)
    const after = { transform: style.transform, opacity: style.opacity, visibility: style.visibility }
    await new Promise(resolve => setTimeout(resolve, 100))
    return { before, after: after.transform, later: getComputedStyle(cover).transform, opacity: after.opacity, visible: after.visibility }
  })
  expect(reversal.opacity).toBe("1")
  expect(reversal.visible).toBe("visible")
  const angleOf = (transform: string) => {
    const numbers = transform.match(/matrix\(([^)]+)\)/)![1]!.split(",").map(Number)
    return Math.atan2(numbers[1]!, numbers[0]!) * 180 / Math.PI
  }
  expect(Math.abs(angleOf(reversal.before) - angleOf(reversal.after))).toBeLessThan(15)
  expect(angleOf(reversal.later)).toBeLessThanOrEqual(angleOf(reversal.before) + 1)
  await expect(column.getByText("No leads", { exact: true })).toBeVisible()
  await expect.poll(() => column.locator(".column-fold-cover").evaluate(element => element.getAnimations().length)).toBe(0)
  await page.emulateMedia({ reducedMotion: "reduce" })
  await column.getByRole("button", { name: "Collapse Rejected", exact: true }).click()
  await expect.poll(() => column.locator(".column-fold-cover").evaluate(element => element.getAnimations().length)).toBe(0)
  await expect.poll(async () => (await column.boundingBox())!.width).toBe(64)
})
