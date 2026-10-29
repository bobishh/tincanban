import { test as base } from "@playwright/test"
import { writeFile } from "node:fs/promises"

export * from "@playwright/test"

// Opt-in collection changes timing. Keep performance benchmarks uninstrumented.
export const test = process.env.TINCANBAN_E2E_COVERAGE === "1" ? base.extend<{ sourceCoverage: void }>({
  sourceCoverage: [async ({ page, browserName }, use, info) => {
    if (browserName !== "chromium" || info.file.endsWith("card-move-performance.spec.ts") || info.file.endsWith("card-drop-zone.spec.ts") || info.file.endsWith("chat-open-performance.spec.ts")) {
      await use()
      return
    }
    const captured: Awaited<ReturnType<typeof page.coverage.stopJSCoverage>> = []
    const goto = page.goto.bind(page)
    const reload = page.reload.bind(page)
    // Retain counters before old execution contexts disappear. Chrome can report
    // only the latest instance of a module after reload despite resetOnNavigation=false.
    const checkpoint = async () => {
      captured.push(...await page.coverage.stopJSCoverage())
      await page.coverage.startJSCoverage({ resetOnNavigation: false })
    }
    await page.coverage.startJSCoverage({ resetOnNavigation: false })
    page.goto = async (...args) => { await checkpoint(); return goto(...args) }
    page.reload = async (...args) => { await checkpoint(); return reload(...args) }
    await use()
    page.goto = goto
    page.reload = reload
    const unavailable = page.isClosed() ? "Fixture page closed before collection" : undefined
    if (!unavailable) captured.push(...await page.coverage.stopJSCoverage())
    const entries = captured.filter(entry => {
      const path = new URL(entry.url).pathname
      return path.startsWith("/src/") && !path.startsWith("/src/vendor/")
    })
    const path = info.outputPath("source-coverage.json")
    await writeFile(path, JSON.stringify({ title: info.titlePath.join(" > "), status: info.status, unavailable, entries }))
    await info.attach("source-coverage", { path, contentType: "application/json" })
  }, { auto: true }],
}) : base
