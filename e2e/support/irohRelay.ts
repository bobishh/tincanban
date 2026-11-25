import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, LaunchOptions } from "@playwright/test"
import { test as coverageTest } from "./coverage"

const relayOrigin = process.env.TINCANBAN_E2E_IROH_RELAY_ORIGIN

function irohRelayLaunchOptions(name: string, existing: LaunchOptions = {}): LaunchOptions {
  if (!relayOrigin || name !== "chromium") return existing
  return { ...existing, args: [...(existing.args ?? []), "--disable-features=LocalNetworkAccessChecks"] }
}

async function configureRelay(context: BrowserContext) {
  if (!relayOrigin) return
  await context.addInitScript(origin => {
    if (location.protocol === "http:" || location.protocol === "https:") {
      localStorage.setItem("tincanban.browser-relay.v1", JSON.stringify({ mode: "custom", urls: [origin] }))
    }
  }, relayOrigin)
}

export const relayTest = coverageTest.extend({
  launchOptions: [async ({ browserName, launchOptions }, use) => {
    await use(irohRelayLaunchOptions(browserName, launchOptions))
  }, { scope: "worker" }],
  context: async ({ context }, use) => {
    await configureRelay(context)
    await use(context)
  },
})

export async function newRelayContext(browser: Browser, options?: BrowserContextOptions) {
  const context = await browser.newContext(options)
  await configureRelay(context)
  return context
}

export function launchRelayBrowser(type: BrowserType) {
  return type.launch(irohRelayLaunchOptions(type.name()))
}
