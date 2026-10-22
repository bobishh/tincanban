import { expect, test } from "./support/coverage"

test("Given Settings is open, when Identity settings render, then generic identity import and export controls are unavailable", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 25_000 })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Identity", exact: true }).click()
  await expect(settings.getByRole("region", { name: "Identity recovery" })).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "Recovery backup", exact: true })).toHaveCount(0)
  await expect(page.getByRole("dialog", { name: "Identity recovery" })).toHaveCount(0)
})
