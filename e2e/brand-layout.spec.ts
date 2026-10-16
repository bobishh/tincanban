import { expect, test } from "./support/coverage"

for (const width of [320, 360, 390]) {
  test(`Given ${width}px mobile header, when Caveat is pending then ${width === 320 ? "fails" : "loads"}, then full brand name stays before controls`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 })
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route("**/caveat-*.woff2", async route => {
      await pending
      if (width === 320) await route.abort()
      else await route.continue()
    })
    await page.goto("/", { waitUntil: "domcontentloaded" })
    const menu = page.getByRole("button", { name: "Menu", exact: true })
    await expect(menu).toBeEnabled()
    const fits = () => page.locator(".brand-name").evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const text = range.getBoundingClientRect()
      const controls = document.querySelector(".topbar-mobile-controls")!.getBoundingClientRect()
      return { text: element.textContent, fits: text.right + 4 <= controls.left && text.left >= 0 && controls.right <= innerWidth }
    })
    expect(await fits()).toEqual({ text: "TINCANBAN", fits: true })
    release()
    await page.evaluate(() => document.fonts.ready)
    expect(await fits()).toEqual({ text: "TINCANBAN", fits: true })
    await page.screenshot({ path: info.outputPath("brand-font-settled.png") })
    await menu.click()
    const navigation = page.getByRole("dialog", { name: "Navigation menu" })
    await expect(navigation).toBeVisible()
  })
}

test("Given owner board, when its can logo opens workspaces, then centered role stamp remains visible", async ({ page }, info) => {
  await page.goto("/")
  const brand = page.getByRole("button", { name: "Open workspaces", exact: true })
  await expect(brand).toBeEnabled()
  await expect(brand.getByRole("img", { name: "Workspace role: owner", exact: true })).toBeVisible()
  await brand.locator(".brand-mark").evaluate(element => {
    const mark = element as HTMLElement
    mark.style.width = "160px"
    mark.style.height = "200px"
  })
  await brand.locator(".brand-mark").screenshot({ path: info.outputPath("can-owner-ribs.png") })
  await brand.click()
  await expect(page.getByRole("dialog", { name: "Workspaces", exact: true })).toBeVisible()
})
