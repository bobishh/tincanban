import { expect, test } from "./support/coverage"
import { writeFile } from "node:fs/promises"
import { populatedBoard } from "./support/detailedBoard"

// Trace snapshots walk this detailed board on the measured main thread.
// Keep the CPU profile, but measure application work without that recorder.
test.use({ trace: "off", reducedMotion: "no-preference" })

test("Given 55 detailed cards, when a card moves, then persistence does not stall the next board interaction", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await populatedBoard(page)
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await session.send("Profiler.enable")
  await page.evaluate(() => {
    const tasks: Array<{ startTime: number; duration: number }> = []
    const taskObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) tasks.push({ startTime: entry.startTime, duration: entry.duration })
    })
    taskObserver.observe({ type: "longtask" })
    Object.assign(window, {
      moveTasks: tasks,
      moveTaskObserver: taskObserver,
      markMovePhase: (name: string) => performance.mark(`move:${name}`),
    })
  })
  const mark = (name: string) => page.evaluate(value =>
    (window as unknown as { markMovePhase: (phase: string) => void }).markMovePhase(value), name)
  const points = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-item-id="performance-card-0"]')!
    const stack = [...document.querySelectorAll<HTMLElement>(".card-stack")].find(element => {
      const title = element.closest(".column")?.querySelector(".column-title h2")?.textContent
      return title === "Doing"
    })!
    const cardRect = card.getBoundingClientRect()
    const stackRect = stack.getBoundingClientRect()
    const targetId = stack.closest<HTMLElement>("[data-column-id]")?.dataset.columnId
    Object.assign(window, { beforeMoveBoard: document.querySelector(".board"), beforeMoveNeighbor: document.querySelector('[data-item-id="performance-card-1"]') })
    return { sourceX: cardRect.x + 4, sourceY: cardRect.y + 4, targetX: stackRect.x + stackRect.width / 2, targetY: stackRect.y + 28, targetId }
  })
  const nextInteraction = page.locator('[data-item-id="performance-card-0"]')
  await session.send("Profiler.start")
  await mark("before-drag")
  await page.mouse.move(points.sourceX, points.sourceY)
  await page.mouse.down()
  await page.mouse.move(points.targetX, points.targetY, { steps: 15 })
  await mark("drag-finished")
  await page.waitForFunction(targetId => document.querySelector(".board-drop-gap")?.getAttribute("data-target-id") === targetId, points.targetId)
  await page.mouse.up()
  await mark("drop-released")
  await page.waitForFunction(() => {
    const movedCard = document.querySelector('[data-item-id="performance-card-0"]')
    return movedCard?.closest(".card-stack")?.closest(".column")?.querySelector(".column-title h2")?.textContent === "Doing" &&
      [...document.querySelectorAll("[role=status]")].some(element => element.textContent?.includes("Item moved"))
  }, undefined, { timeout: 15_000 })
  await mark("move-persisted")
  await nextInteraction.click()
  await mark("detail-click")
  await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-label="Item overview"]'))
  await mark("detail-visible")
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await mark("two-frames")
  const { profile } = await session.send("Profiler.stop")
  const measured = await page.evaluate(() => {
    const windowState = window as unknown as {
      moveTasks: Array<{ startTime: number; duration: number }>
      moveTaskObserver: PerformanceObserver
      beforeMoveBoard: Element
      beforeMoveNeighbor: Element
    }
    const tasks = [...windowState.moveTasks, ...windowState.moveTaskObserver.takeRecords().map(entry => ({ startTime: entry.startTime, duration: entry.duration }))]
    windowState.moveTaskObserver.disconnect()
    const marks = performance.getEntriesByType("mark").filter(entry => entry.name.startsWith("move:")).map(({ name, startTime }) => ({ name, startTime }))
    return {
      tasks,
      marks,
      sameBoard: windowState.beforeMoveBoard === document.querySelector(".board"),
      sameNeighbor: windowState.beforeMoveNeighbor === document.querySelector('[data-item-id="performance-card-1"]'),
    }
  })
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await writeFile(testInfo.outputPath("move.cpuprofile"), JSON.stringify(profile))
  await writeFile(testInfo.outputPath("move.measurement.json"), JSON.stringify(measured))
  await expect(page.getByRole("dialog", { name: "Item overview" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible()
  expect(measured.sameBoard && measured.sameNeighbor).toBe(true)
  const longestTask = Math.max(0, ...measured.tasks.map(task => task.duration))
  if (longestTask >= 160) {
    const phases = measured.tasks.filter(task => task.duration >= 100).map(task => ({
      ...task,
      phase: measured.marks.filter(mark => mark.startTime <= task.startTime).at(-1)?.name ?? "before-move",
    }))
    console.info(`Card move phase diagnostics: ${JSON.stringify({ phases, marks: measured.marks })}`)
  }
  console.info(`Card move, 55 detailed cards, 4x CPU: longest main-thread task ${Math.round(longestTask)}ms`)
  expect(longestTask).toBeLessThan(200)
  // Cold startup is a durability check, separate from the throttled interaction.
  await page.reload()
  // Reload readiness waits for full-history admission; the 200ms interaction gate stays unchanged.
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByText("Performance card 0", { exact: true })).toBeVisible({ timeout: 60_000 })
})
