import type { Page } from "@playwright/test"

/** Observe the page's real heartbeat timers without replacing their scheduling. */
export async function observeMeshHeartbeats(page: Page) {
  await page.route("**/mesh-transport/src/index.ts*", async route => {
    const response = await route.fetch()
    const source = await response.text()
    if (!source.includes("function startMeshHeartbeat")) throw new Error("Heartbeat observation target changed")
    await route.fulfill({ response, body: `${source}\n;(() => {
      if (typeof window === "undefined") return
      window.__meshObservedHeartbeats = 0
      const start = startMeshHeartbeat
      startMeshHeartbeat = (...args) => {
        const stop = start(...args)
        window.__meshObservedHeartbeats += 1
        let stopped = false
        return () => {
          stop()
          if (!stopped) { stopped = true; window.__meshObservedHeartbeats -= 1 }
        }
      }
    })()` })
  })
}

export async function activeMeshHeartbeats(page: Page) {
  return page.evaluate(() => {
    const count = (window as Window & { __meshObservedHeartbeats?: number }).__meshObservedHeartbeats
    if (count === undefined) throw new Error("Heartbeat observation did not load")
    return count
  })
}
