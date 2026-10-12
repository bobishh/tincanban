import { expect, test, type Page } from "./support/coverage"
import { expectFaviconColor, faviconChanges, faviconRole } from "./support/favicon"

async function faviconLoads(page: Page, center: number[], body = [200, 201, 203, 255]) {
  const href = await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute("href")

  const image = await page.evaluate(async (src) => {
    const icon = new Image()
    icon.src = src!
    await icon.decode()
    const canvas = document.createElement("canvas")
    canvas.width = 64
    canvas.height = 64
    const context = canvas.getContext("2d")!
    context.drawImage(icon, 0, 0)
    const pixel = (x: number, y: number) => [...context.getImageData(x, y, 1, 1).data]
    return {
      width: icon.naturalWidth,
      height: icon.naturalHeight,
      corner: pixel(0, 0),
      interior: pixel(22, 14),
      metal: pixel(29, 34),
    }
  }, href)
  expect({ width: image.width, height: image.height }).toEqual({ width: 64, height: 64 })
  expect(image.corner[3]).toBe(0)
  center.forEach((channel, index) => expect(Math.abs(image.interior[index]! - channel)).toBeLessThanOrEqual(2))
  expect(image.interior[3]).toBe(255)
  expect(image.metal).toEqual(body)
}

test("Given a ready board with no peers, when its tab opens, then tincanban favicon matches empty mesh without blinking", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  await expectFaviconColor(page, "#ffd43b")
  await expect(page.locator('.can-role-stamp[data-role-stamp="owner"]')).toBeVisible()
  await expect.poll(() => faviconRole(page)).toEqual({ role: "owner", body: "#d5b16d" })
  await faviconLoads(page, [255, 212, 59], [213, 177, 109, 255])
  expect(await faviconChanges(page)).toBe(0)
})

test("Given app startup fails, when its tab opens, then tincanban icon still loads", async ({ page }) => {
  await page.route("**/src/main.ts", route => route.abort())
  await page.goto("/", { waitUntil: "domcontentloaded" })
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute("href", /^(?:\/favicon\.svg\?v=\d+|data:image\/svg\+xml,)/)
  await faviconLoads(page, [105, 219, 124])
})

test("Given favicon animation cannot load, when the board opens, then the static icon and local board remain available", async ({ page }) => {
  await page.route("**/favicon.svg?v=9", route => route.request().resourceType() === "fetch"
    ? route.fulfill({ status: 503, body: "Unavailable" }) : route.continue())
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  await expect(page.getByLabel("Mesh empty", { exact: true })).toBeVisible()
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute("href", "/favicon.svg?v=9")
  await faviconLoads(page, [105, 219, 124])
})

test("Given a malformed optional favicon, when startup and later motion changes render it, then the board stays editable without runtime errors", async ({ page }) => {
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  await page.route("**/favicon.svg?v=9", route => route.request().resourceType() === "fetch"
    ? route.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" />' }) : route.continue())
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  await expect(page.locator('.can-role-stamp[data-role-stamp="owner"]')).toBeVisible()
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute("href", "/favicon.svg?v=9")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
  expect(errors).toEqual([])
})
