import { expect, test } from "./support/coverage"

test("Given a board window, When another application window opens, Then both remain usable without a modal backdrop", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  const header = page.locator(".topbar")
  const syncTrigger = page.getByRole("button", { name: "Sync", exact: true })
  await syncTrigger.click()
  const sync = page.getByRole("dialog", { name: "Device sync", exact: true })
  await expect(sync).toBeVisible()
  await expect(header).not.toHaveAttribute("inert", "")
  await expect(page.locator(".overlay")).toHaveCount(0)

  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(settings).toBeVisible()
  await expect(sync).toBeVisible()
  await settings.getByRole("tab", { name: "Identity", exact: true }).click()
  await expect(settings.getByLabel("Name", { exact: true })).toBeVisible()
})
