import { expect, test } from "./support/coverage"

test("Given Device sync members are open, when the user wants to dismiss it, then only the header close control is shown", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect(dialog).toBeHidden()
})

test("Given automatic live sync, when Sync opens, then participants and storage are visible without public transport switches", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("list", { name: "Mesh members" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: /(?:Start|Stop) live sync/ })).toHaveCount(0)
})

test("Given Rusty is current and no other browser is online, when Device sync opens, then show idle peer status and keep peer errors visible", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => {
    const { mountRustyAvailableSyncDialog } = await import("/e2e/support/keeperDialog.ts")
    await mountRustyAvailableSyncDialog()
  })

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  const summary = dialog.locator(".mesh-connection-summary")
  await expect(summary).toHaveText("No other devices online · Rusty sync remains available.")
  await expect(summary).not.toHaveClass(/is-warning/)
  await expect(dialog.getByText("Reconnect: Workspace board unavailable: remote browser is unavailable")).toBeVisible()
})

test("Given Rusty was recently current but internet is offline, when Device sync opens, then keep the offline warning", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => {
    const { mountRustyAvailableSyncDialog } = await import("/e2e/support/keeperDialog.ts")
    await mountRustyAvailableSyncDialog({ networkOnline: false })
  })

  const summary = page.getByRole("dialog", { name: "Device sync" }).locator(".mesh-connection-summary")
  await expect(summary).toHaveText("Devices offline · Waiting for internet. Changes stay saved on this device.")
  await expect(summary).toHaveClass(/is-warning/)
})

test("Given Device sync shows an invalid-link failure, when it renders recovery actions, then Dismiss remains and Close is not duplicated", async ({ page }) => {
  await page.goto("/pair#invalid")

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Dismiss", exact: true })).toBeVisible()
})

test("Given many devices in a mobile sync window, when their list is scrolled, then the list moves without scrolling or locking the board", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 640 })
  await page.goto("/")
  const backgroundScroll = await page.evaluate(() => window.scrollY)

  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.evaluate(async () => {
    const { mountMobileDeviceListDialog } = await import("/e2e/support/keeperDialog.ts")
    mountMobileDeviceListDialog()
  })
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button").filter({ hasText: "Mobile test participant" }).click()
  const devices = dialog.getByRole("list", { name: "Devices for Mobile test participant" })
  const boardTop = await page.locator(".board").evaluate(board => board.getBoundingClientRect().top)

  await expect.poll(() => devices.evaluate(list => list.scrollHeight > list.clientHeight)).toBe(true)
  await devices.hover()
  await page.mouse.wheel(0, 500)
  await expect.poll(() => devices.evaluate(list => list.scrollTop)).toBeGreaterThan(0)
  await expect(dialog).not.toHaveAttribute("aria-modal", "true")
  expect(await page.locator(".board").evaluate(board => board.getBoundingClientRect().top)).toBe(boardTop)

  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(backgroundScroll)
})

test("Given desktop participants and many devices, when selecting people and resizing Sync, then details remain usable in wide and narrow windows", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/")
  await page.evaluate(async () => {
    const { mountMobileDeviceListDialog } = await import("/e2e/support/keeperDialog.ts")
    mountMobileDeviceListDialog({ includeOwner: true })
  })
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button").filter({ hasText: "Mobile test participant" }).click()
  const devices = dialog.getByRole("list", { name: "Devices for Mobile test participant" })
  await expect(devices.getByRole("listitem")).toHaveCount(20)
  await dialog.getByRole("button", { name: "Maximize window", exact: true }).click()
  await dialog.screenshot({ path: testInfo.outputPath("sync-desktop-details.png") })
  await devices.hover()
  await page.mouse.wheel(0, 500)
  await expect.poll(() => devices.evaluate(list => list.scrollTop)).toBeGreaterThan(0)
  await dialog.getByRole("button").filter({ hasText: "Workspace owner" }).click()
  await expect(dialog.getByRole("list", { name: "Devices for Workspace owner" }).getByRole("listitem")).toHaveCount(1)
  await expect(dialog.locator(".mesh-device-status")).toHaveText("No connection")
  await dialog.getByRole("button", { name: "Restore window size", exact: true }).click()
  const resize = dialog.getByRole("button", { name: "Resize dialog with arrow keys" })
  for (let index = 0; index < 12; index++) await resize.press("ArrowLeft")
  await dialog.getByRole("button").filter({ hasText: "Mobile test participant" }).click()
  await expect(devices.getByRole("listitem")).toHaveCount(20)
  await dialog.screenshot({ path: testInfo.outputPath("sync-narrow-details.png") })
})
