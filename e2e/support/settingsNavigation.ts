import { expect, type Page } from "./coverage"

export async function openSettingsFromSync(page: Page, section: "Identity" | "Workspace") {
  const sync = page.getByRole("dialog", { name: "Device sync", exact: true })
  if (await sync.isVisible()) await sync.getByRole("button", { name: "Close", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  if (!await settings.isVisible()) {
    const action = page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true })
    const menu = page.getByRole("button", { name: "Menu", exact: true })
    await expect(action.or(menu).first()).toBeVisible({ timeout: 30_000 })
    if (!await action.count()) await menu.click()
    await action.click()
  }
  await settings.getByRole("tab", { name: section, exact: true }).click()
  return settings
}
