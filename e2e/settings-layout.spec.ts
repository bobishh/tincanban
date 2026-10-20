import { expect, test } from "./support/coverage"

test("Given unsaved profile and invalid settings, when settings tabs change, then the profile draft survives and invalid changes stay blocked", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.goto("/")
  await page.getByRole("button", { name: "Menu", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
  await dialog.getByRole("tab", { name: "Identity", exact: true }).click()
  await dialog.getByLabel("Name", { exact: true }).fill("Kept draft")
  await dialog.getByRole("tab", { name: "settings.json", exact: true }).click()
  await dialog.getByRole("textbox", { name: "Workspace settings JSON" }).fill("{")
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Apply JSON" })).toBeDisabled()
  await dialog.getByRole("tab", { name: "Identity", exact: true }).click()
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Kept draft")
})
