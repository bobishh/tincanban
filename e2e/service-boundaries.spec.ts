import { expect, test } from "./support/coverage"

for (const width of [390, 1440]) {
  test(`Given a ${width}px board and unavailable external services, when opening settings, then service consoles are absent and Rusty remains in Sync`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route(/https:\/\/(automation|reflux)\.meta-uber-engineer\.dev\//, route => route.abort())
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const create = page.getByRole("dialog", { name: "Create workspace" })
    await create.getByLabel("Title", { exact: true }).fill("Service boundaries")
    await create.getByRole("button", { name: "Create", exact: true }).click()
    await expect(create).toBeHidden()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const settings = page.getByRole("dialog", { name: "Settings", exact: true })
    await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
    await expect(settings.getByRole("region", { name: "Workspace status", exact: true })).toBeVisible()
    await expect(settings.getByRole("region", { name: "Automations", exact: true })).toHaveCount(0)
    await expect(settings.getByRole("region", { name: "Workspace diagnostics", exact: true })).toHaveCount(0)
    await expect(settings.getByRole("link", { name: "Open board logs" })).toHaveCount(0)
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
    await page.getByRole("button", { name: "Open Device sync", exact: true }).click()
    const sync = page.getByRole("dialog", { name: "Device sync" })
    await expect(sync.getByRole("tab", { name: "Rusty", exact: true })).toBeVisible()
  })
}
