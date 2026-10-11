import { expect, test } from "./support/coverage"

for (const width of [1280, 390]) {
  test(`Given sync management at ${width}px, when offline and then paused, then status and actions remain readable`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
    // Given real route and isolated synthetic member state, no live network fixture.
    await page.evaluate(async () => {
      const { mountSyncLayoutDialog } = await import("/e2e/support/keeperDialog.ts")
      await mountSyncLayoutDialog()
    })
    const dialog = page.getByRole("dialog", { name: "Device sync" })
    const summary = dialog.locator(".mesh-connection-summary")
    await expect(summary).toContainText("Devices offline")
    await expect(summary).toHaveCSS("background-color", "rgb(255, 212, 59)")
    await expect(dialog.getByRole("button", { name: "Add someone", exact: true })).not.toHaveClass(/button-primary/)
    await dialog.getByText("Advanced", { exact: true }).click()
    await expect(dialog.getByRole("button", { name: "Leave mesh", exact: true })).toHaveClass(/button-danger/)
    await dialog.getByRole("tab", { name: "Participants", exact: true }).click()
    const member = dialog.getByRole("button").filter({ hasText: "Bo" }).first()
    const centers = await member.evaluate(el => {
      const dot = el.querySelector(".mesh-member-presence")!.getBoundingClientRect()
      const badge = el.querySelector(".mesh-member-role")!.getBoundingClientRect()
      return { dot: dot.y + dot.height / 2, badge: badge.y + badge.height / 2 }
    })
    expect(Math.abs(centers.dot - centers.badge)).toBeLessThan(1)
    await dialog.getByRole("tab", { name: "Participants", exact: true }).click()
    await dialog.getByRole("tab", { name: "Advanced", exact: true }).click()
    const succession = dialog.getByRole("region", { name: "Ownership succession" })
    await expect(dialog.getByRole("heading", { name: "Ownership succession", exact: true })).toHaveCount(1)
    await expect(dialog.getByLabel("Recovery participant", { exact: true })).toHaveCount(0)
    await expect(succession.getByText("No recovery policy.", { exact: true })).toBeVisible()
    await expect(succession.locator(".sync-helper-text")).toHaveText("Owner: name a successor or enable editor quorum.")
    await dialog.getByRole("tab", { name: "Advanced", exact: true }).click()
    await dialog.getByRole("button", { name: "Stop live sync", exact: true }).click()
    await expect(dialog.getByRole("button", { name: "Start live sync", exact: true })).toBeVisible()
    await expect(summary).not.toHaveClass(/is-warning/)
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`sync-${width}.png`), fullPage: true })
    const colors = await page.locator(".topbar").evaluate(el => ({ header: getComputedStyle(el).backgroundColor, body: getComputedStyle(document.body).backgroundColor }))
    expect(colors.header).toBe(colors.body)
  })
}
