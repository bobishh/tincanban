import { expect, test } from "./support/coverage"
import { populatedBoard } from "./support/detailedBoard"
import { writeFile } from "node:fs/promises"

test.use({ trace: "off", reducedMotion: "no-preference" })

for (const targetHasCard of [false, true]) {
  test(`Given a tall source and ${targetHasCard ? "short" : "empty"} destination, when dropping near the column bottom, then card moves and survives reload`, async ({ page }) => {
    test.setTimeout(120_000)
    await populatedBoard(page, true)
    if (targetHasCard) await page.evaluate(async () => {
      const state = (await import("/src/test/stateFixture.ts")).useTincanban()
      const destination = state.genericColumns.value.find(column => column.title === "Applied")!
      await state.executeCommandAsync({ kind: "moveEntity", entityId: "performance-card-1", parentId: destination.id, beforeId: null })
    })
    await dropNearBottom(page)
    await expect(page.getByRole("status")).toContainText("Item moved", { timeout: 15_000 })
    const destination = page.getByRole("region", { name: "Applied", exact: true })
    await expect(destination.getByRole("button", { name: "Open Performance card 54", exact: true })).toBeVisible()
    const columnBox = (await destination.boundingBox())!
    const stackBox = (await destination.locator(".card-stack").boundingBox())!
    expect(stackBox.y - columnBox.y).toBeLessThan(3)
    expect(columnBox.y + columnBox.height - stackBox.y - stackBox.height).toBeLessThan(3)
    const cardBox = (await destination.locator(".lead-card").last().boundingBox())!
    const addBox = (await destination.getByRole("button", { name: "Add lead to Applied", exact: true }).boundingBox())!
    expect(addBox.y - cardBox.y - cardBox.height).toBeGreaterThanOrEqual(0)
    expect(addBox.y - cardBox.y - cardBox.height).toBeLessThan(30)
    await page.reload()
    // Full-history admission gates workspace readiness after reload; keep this separate from the interaction budget.
    await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 60_000 })
    await expect(destination.getByRole("button", { name: "Open Performance card 54", exact: true })).toBeVisible()
  })
}

test("Given storage failure, when dropping near an empty column bottom, then card returns and retry moves it", async ({ page }) => {
  await populatedBoard(page, true)
  await page.evaluate(() => { (window as unknown as { __TINCANBAN_INJECT_STORAGE_FAILURE__: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
  await dropNearBottom(page)
  await expect(page.getByRole("status")).toContainText("Move failed", { timeout: 15_000 })
  await expect(page.getByRole("region", { name: "Lead", exact: true }).getByRole("button", { name: "Open Performance card 54", exact: true })).toBeVisible()
  await expect(page.getByRole("region", { name: "Applied", exact: true }).locator(".lead-card")).toHaveCount(0)
  await expect(page.locator(".board-drag-preview, .board-drop-gap, .board-drag-source")).toHaveCount(0)
  await page.evaluate(() => { (window as unknown as { __TINCANBAN_INJECT_STORAGE_FAILURE__: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })
  await dropNearBottom(page)
  await expect(page.getByRole("status")).toContainText("Item moved", { timeout: 15_000 })
})

test("Given 55 detailed leads, when a card drops into blank column space, then pointer response and main-thread work stay below 200ms", async ({ page }, testInfo) => {
  await populatedBoard(page, true)
  const destinationId = await page.getByRole("region", { name: "Applied", exact: true }).getAttribute("data-column-id")
  const source = page.getByRole("button", { name: "Open Performance card 54", exact: true })
  await source.hover()
  const sourceBounds = (await source.boundingBox())!
  const x = sourceBounds.x + sourceBounds.width / 2
  const y = sourceBounds.y + Math.min(30, sourceBounds.height / 2)
  await page.mouse.move(x, y)
  await expect.poll(() => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-item-id]")?.getAttribute("data-item-id"), { x, y })).toBe("performance-card-54")

  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await session.send("Profiler.enable")
  await page.evaluate(() => {
    const tasks: number[] = []
    const events: Array<{ name: string; duration: number; inputDelay: number; processing: number }> = []
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === "longtask") tasks.push(entry.duration)
        else {
          const event = entry as PerformanceEventTiming
          if (event.interactionId) events.push({ name: event.name, duration: event.duration,
            inputDelay: event.processingStart - event.startTime, processing: event.processingEnd - event.processingStart })
        }
      }
    })
    observer.observe({ type: "longtask" })
    observer.observe({ type: "event", durationThreshold: 16 })
    Object.assign(window, { dropMeasurement: { tasks, events, observer } })
  })
  await session.send("Profiler.start")
  await page.mouse.down()
  await page.mouse.move(x + 12, y, { steps: 3 })
  await page.waitForFunction(() => document.querySelector(".board-drag-preview"))
  const destination = await blankColumnPoint(page)
  await page.mouse.move(destination.x, destination.y, { steps: 18 })
  await page.waitForFunction(targetId => document.querySelector(".board-drop-gap")?.getAttribute("data-target-id") === targetId, destinationId)
  await page.waitForFunction(() => {
    const preview = document.querySelector(".board-drag-preview")
    const sourceCard = document.querySelector('[data-item-id="performance-card-54"]')
    return preview?.querySelector(".card-layout")?.textContent === sourceCard?.querySelector(".card-layout")?.textContent
  })
  await page.mouse.up()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const { profile } = await session.send("Profiler.stop")
  const measured = await page.evaluate(() => {
    const data = (window as unknown as { dropMeasurement: { tasks: number[]; events: Array<{ name: string; duration: number; inputDelay: number; processing: number }>; observer: PerformanceObserver } }).dropMeasurement
    data.tasks.push(...data.observer.takeRecords().filter(entry => entry.entryType === "longtask").map(entry => entry.duration))
    data.observer.disconnect()
    return { tasks: data.tasks, events: data.events }
  })
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await writeFile(testInfo.outputPath("drop.cpuprofile"), JSON.stringify(profile))
  await writeFile(testInfo.outputPath("drop.measurement.json"), JSON.stringify(measured, null, 2))
  const pointerMs = Math.max(0, ...measured.events.map(event => event.duration))
  const taskMs = Math.max(0, ...measured.tasks)
  console.info(`Bottom drop, 55 detailed leads, 4x CPU: pointer ${pointerMs}ms; longest task ${Math.round(taskMs)}ms`)
  expect(pointerMs).toBeLessThan(200)
  expect(taskMs).toBeLessThan(200)
  await expect(page.getByRole("status")).toContainText("Item moved", { timeout: 15_000 })
  await expect(page.getByRole("region", { name: "Applied", exact: true }).getByRole("button", { name: "Open Performance card 54", exact: true })).toBeVisible()
})

async function dropNearBottom(page: import("@playwright/test").Page) {
  const source = page.getByRole("button", { name: "Open Performance card 54", exact: true })
  await source.hover()
  const sourceBounds = (await source.boundingBox())!
  const sourceContent = await page.locator('[data-item-id="performance-card-54"] .card-layout').textContent()
  const x = sourceBounds.x + sourceBounds.width / 2
  const y = sourceBounds.y + Math.min(30, sourceBounds.height / 2)
  await page.mouse.move(x, y)
  await expect.poll(() => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-item-id]")?.getAttribute("data-item-id"), { x, y })).toBe("performance-card-54")
  await page.mouse.down()
  await page.mouse.move(x + 12, y, { steps: 3 })
  const preview = page.locator(".board-drag-preview")
  await expect(preview).toBeVisible()
  await expect(preview.locator(".card-layout")).toHaveText(sourceContent!)
  const destination = await blankColumnPoint(page)
  await page.mouse.move(destination.x, destination.y, { steps: 18 })
  const target = page.getByRole("region", { name: "Applied", exact: true })
  await expect(page.locator(".board-drop-gap")).toHaveAttribute("data-target-id", await target.getAttribute("data-column-id"))
  await expect(target.locator('[data-item-id="performance-card-54"]')).toHaveCount(0)
  await page.mouse.up()
}

async function blankColumnPoint(page: import("@playwright/test").Page) {
  // Starting a drag can scroll and reveal virtualized cards; use current column bounds.
  const column = page.getByRole("region", { name: "Applied", exact: true })
  const bounds = (await column.boundingBox())!
  const point = { x: bounds.x + bounds.width / 2,
    y: Math.min(page.viewportSize()!.height - 120, bounds.y + bounds.height - 80) }
  expect(point.y - bounds.y).toBeGreaterThan(500)
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest("[data-column-id]")?.getAttribute("data-column-id"), point)
  expect(hit, JSON.stringify({ bounds, point, hit })).toBe(await column.getAttribute("data-column-id"))
  return point
}
