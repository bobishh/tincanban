import { expect, type Page } from "./coverage"

async function faviconColor(page: Page) {
  return page.locator('link[rel="icon"][type="image/svg+xml"]').evaluate(link => {
    const href = link.getAttribute("href") ?? ""
    if (!href.startsWith("data:image/svg+xml,")) return null
    const svg = new DOMParser().parseFromString(decodeURIComponent(href.split(",")[1]!), "image/svg+xml")
    return svg.querySelector("[data-connection-fill]")?.getAttribute("fill") ?? null
  })
}

export async function expectFaviconColor(page: Page, color: string) {
  await expect.poll(() => faviconColor(page)).toBe(color)
}

export async function faviconChanges(page: Page, milliseconds = 1_100) {
  return page.locator('link[rel="icon"][type="image/svg+xml"]').evaluate((link, delay) => new Promise<number>(resolve => {
    let changes = 0
    const observer = new MutationObserver(records => { changes += records.length })
    observer.observe(link, { attributes: true, attributeFilter: ["href"] })
    setTimeout(() => { observer.disconnect(); resolve(changes) }, delay)
  }), milliseconds)
}

export async function faviconRole(page: Page) {
  return page.locator('link[rel="icon"][type="image/svg+xml"]').evaluate(link => {
    const href = link.getAttribute("href") ?? ""
    if (!href.startsWith("data:image/svg+xml,")) return null
    const svg = new DOMParser().parseFromString(decodeURIComponent(href.split(",")[1]!), "image/svg+xml")
    return { role: svg.querySelector("[data-role-stamp]")?.getAttribute("data-role-stamp") ?? null,
      body: svg.querySelector("[data-can-body]")?.getAttribute("fill") ?? null }
  })
}
