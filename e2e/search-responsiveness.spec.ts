import { expect, test } from "./support/coverage"
import { writeFile } from "node:fs/promises"
import { populatedBoard } from "./support/detailedBoard"

test.use({ trace: "off" })

test("Given 55 detailed leads, when search narrows then has no matches, then keyboard stays responsive and clearing restores cards without writes", async ({ page }, testInfo) => {
  await populatedBoard(page, true)
  const search = page.getByRole("searchbox", { name: "Search cards" })
  await search.click()
  await page.evaluate(async () => {
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  })
  const session = await page.context().newCDPSession(page)
  // Exclude garbage left by the large signed-board fixture from the interaction measurement.
  // Collections caused by the search itself remain inside the measured interval.
  await session.send("HeapProfiler.collectGarbage")
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await session.send("Profiler.enable")
  await page.evaluate(async () => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const events: Array<{ name: string; duration: number; input: number; processing: number }> = []
    const paints: number[] = []
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        if (entry.interactionId && ["keydown", "keyup", "keypress"].includes(entry.name)) events.push({ name: entry.name, duration: entry.duration,
          input: entry.processingStart - entry.startTime, processing: entry.processingEnd - entry.processingStart })
      }
    })
    observer.observe({ type: "event", durationThreshold: 16 })
    document.querySelector('input[aria-label="Search cards"]')!.addEventListener("input", () => {
      const start = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => paints.push(performance.now() - start)))
    }, true)
    Object.assign(window, { searchMeasurement: { events, paints, observer, version: state.docVersion.value } })
  })
  await session.send("Profiler.start")
  await search.pressSequentially("performance card 0", { delay: 25 })
  await expect(page.locator(".board .lead-card")).toHaveCount(1)
  await expect(page.locator(".board .lead-card")).toContainText("Detailed job requirements")
  await search.pressSequentially(" missing", { delay: 25 })
  await expect(page.locator(".board .lead-card")).toHaveCount(0)
  await expect(page.getByText("Try another search or clear filters to see all cards.", { exact: true })).toBeVisible()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const { profile } = await session.send("Profiler.stop")
  const measured = await page.evaluate(async () => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const data = (window as unknown as { searchMeasurement: { events: Array<{ name: string; duration: number; input: number; processing: number }>;
      paints: number[]; observer: PerformanceObserver; version: number } }).searchMeasurement
    data.observer.disconnect()
    return { events: data.events, paints: data.paints, unchangedVersion: data.version === state.docVersion.value }
  })
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await writeFile(testInfo.outputPath("search.cpuprofile"), JSON.stringify(profile))
  await writeFile(testInfo.outputPath("search.measurement.json"), JSON.stringify(measured, null, 2))
  console.info(`Search, 55 detailed leads, 4x CPU: keyboard ${Math.max(0, ...measured.events.map(event => event.duration))}ms; slowest paint ${Math.round(Math.max(...measured.paints))}ms`)
  expect(measured.paints).toHaveLength(26)
  expect(Math.max(0, ...measured.events.map(event => event.duration))).toBeLessThan(200)
  expect(Math.max(...measured.paints)).toBeLessThan(200)
  expect(measured.unchangedVersion).toBe(true)
  await search.fill("performance card 0")
  await expect(page.locator(".board .lead-card")).toHaveCount(1)
  const filteredCard = page.locator('[data-item-id="performance-card-0"]')
  const notePreview = filteredCard.locator(".card-notes")
  await expect(notePreview).toContainText("…")
  expect((await notePreview.textContent())?.length).toBeLessThan(500)
  await search.fill("portfolio link")
  await expect(page.locator(".board .lead-card")).toHaveCount(55)
  await expect(notePreview).toContainText("Portfolio link available on request")
  expect((await notePreview.textContent())?.length).toBeLessThan(500)
  await filteredCard.locator(".card-open-button").click()
  const detail = page.getByRole("dialog", { name: "Item overview" })
  await expect(detail).toBeVisible()
  const fullNarrative = await detail.locator(".detail-copy").textContent()
  expect(fullNarrative).toContain("Detailed job requirements")
  expect(fullNarrative?.length).toBeGreaterThan(8_000)
  await page.keyboard.press("Escape")
  await expect(detail).toBeHidden()
  await search.fill("performance card 54")
  await expect(page.locator(".board .lead-card")).toHaveCount(1)
  const lastCard = page.locator('[data-item-id="performance-card-54"]')
  await lastCard.scrollIntoViewIfNeeded()
  await expect(lastCard.locator(".card-notes")).toContainText("Detailed job requirements")
  await search.fill("")
  await expect(page.locator(".board .lead-card")).toHaveCount(55)
})
