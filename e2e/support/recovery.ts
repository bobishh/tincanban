import type { Page } from "@playwright/test"

type CapturedNode = { close: (reason?: string) => Promise<void>; endpointId: string; __matchE2eClosed?: boolean }

declare global {
  interface Window {
    __TINCANBAN_E2E_RECOVERY_NODES__?: CapturedNode[]
    __TINCANBAN_E2E_RECOVERY_CLOSED_NODES__?: number
  }
}

/**
 * Captures nodes returned by the real Vite-served Iroh transport.  The route
 * changes only this test browser's module response; it never substitutes a
 * transport, connection, or node.
 */
export async function captureRealIrohNodes(page: Page) {
  await page.route("**/src/sync/irohTransport.ts*", async route => {
    const response = await route.fetch()
    const source = await response.text()
    await route.fulfill({
      response,
      body: `${source}\n;(() => {\n  const originalStart = irohTransport.start.bind(irohTransport)\n  irohTransport.start = async (...args) => {\n    const node = await originalStart(...args)\n    const originalClose = node.close.bind(node)\n    let closed = false\n    node.close = async (...closeArgs) => {\n      const result = await originalClose(...closeArgs)\n      if (!closed) {\n        closed = true\n        node.__matchE2eClosed = true\n        window.__TINCANBAN_E2E_RECOVERY_CLOSED_NODES__ = (window.__TINCANBAN_E2E_RECOVERY_CLOSED_NODES__ ?? 0) + 1\n      }\n      return result\n    }\n    ;(window.__TINCANBAN_E2E_RECOVERY_NODES__ ??= []).push(node)\n    return node\n  }\n})()`,
    })
  })
}

export async function closeLatestRealIrohNode(page: Page, endpoint?: string) {
  await page.evaluate(async currentEndpoint => {
    const node = window.__TINCANBAN_E2E_RECOVERY_NODES__?.findLast(candidate =>
      !candidate.__matchE2eClosed && (!currentEndpoint || candidate.endpointId.startsWith(currentEndpoint)))
    if (!node) throw new Error("No real Iroh node was captured")
    await node.close("E2E unexpected transport close")
  }, endpoint)
}

export async function realIrohNodeOwnership(page: Page) {
  return page.evaluate(() => ({
    created: window.__TINCANBAN_E2E_RECOVERY_NODES__?.length ?? 0,
    closed: window.__TINCANBAN_E2E_RECOVERY_CLOSED_NODES__ ?? 0,
    active: (window.__TINCANBAN_E2E_RECOVERY_NODES__?.length ?? 0) - (window.__TINCANBAN_E2E_RECOVERY_CLOSED_NODES__ ?? 0),
  }))
}
