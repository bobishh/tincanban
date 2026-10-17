import { expect, test } from "./support/coverage"
import { writeFile } from "node:fs/promises"
import { populatedBoard } from "./support/detailedBoard"

test.use({ trace: "off" })

test("Given 55 detailed leads, when Company and Role are typed, then keystrokes paint within 200ms and only Save commits", async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  await populatedBoard(page, true)
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Edit", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Edit item" })
  await expect(form).toBeVisible()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await session.send("Profiler.enable")
  await page.evaluate(async () => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const paints: number[] = []
    const events: number[] = []
    const tasks: number[] = []
    const eventObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        if (entry.interactionId && ["keydown", "keyup"].includes(entry.name)) events.push(entry.duration)
      }
    })
    eventObserver.observe({ type: "event", durationThreshold: 16 })
    const taskObserver = new PerformanceObserver(list => { tasks.push(...list.getEntries().map(entry => entry.duration)) })
    taskObserver.observe({ type: "longtask" })
    const dialog = document.querySelector('[role="dialog"][aria-label="Edit item"]')!
    dialog.addEventListener("input", () => {
      const start = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => paints.push(performance.now() - start)))
    }, true)
    Object.assign(window, { editMeasurement: { paints, events, tasks, eventObserver, taskObserver, version: state.docVersion.value } })
  })
  await session.send("Profiler.start")
  for (const label of ["Company *", "Role *"]) {
    const input = form.getByLabel(label)
    await input.focus()
    await input.press("End")
    await input.pressSequentially(" responsive draft", { delay: 25 })
    await expect(input).toHaveValue(/responsive draft$/)
  }
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const { profile } = await session.send("Profiler.stop")
  const measured = await page.evaluate(async () => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const data = (window as unknown as { editMeasurement: {
      paints: number[]; events: number[]; tasks: number[]; version: number;
      eventObserver: PerformanceObserver; taskObserver: PerformanceObserver;
    } }).editMeasurement
    data.tasks.push(...data.taskObserver.takeRecords().map(entry => entry.duration))
    data.eventObserver.disconnect()
    data.taskObserver.disconnect()
    return { paints: data.paints, events: data.events, tasks: data.tasks, unchangedVersion: data.version === state.docVersion.value }
  })
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await writeFile(testInfo.outputPath("edit.cpuprofile"), JSON.stringify(profile))
  await writeFile(testInfo.outputPath("edit.measurement.json"), JSON.stringify(measured, null, 2))
  console.info(`Card typing, 55 detailed leads, 4x CPU: slowest paint ${Math.round(Math.max(...measured.paints))}ms; keyboard Event Timing ${Math.max(0, ...measured.events)}ms; longest task ${Math.round(Math.max(0, ...measured.tasks))}ms`)
  expect(measured.paints).toHaveLength(34)
  expect(Math.max(...measured.paints)).toBeLessThan(200)
  expect(Math.max(0, ...measured.events)).toBeLessThan(200)
  expect(measured.unchangedVersion).toBe(true)
  await expect(page.getByRole("button", { name: "Open Performance card 0", exact: true, includeHidden: true })).toHaveCount(1)
  await form.getByRole("button", { name: "Save changes" }).click()
  await expect(form).toBeHidden({ timeout: 15_000 })
  await page.reload()
  // Full-history admission gates workspace readiness after reload; the typing and paint limits stay unchanged.
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 60_000 })
  await page.getByRole("button", { name: /^Open Performance card 0 responsive draft/ }).click()
  await expect(page.getByRole("dialog", { name: "Item overview" })).toContainText("Senior Software Engineer responsive draft")
})
