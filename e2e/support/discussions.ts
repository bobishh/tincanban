import { expect, type Locator, type Page } from "@playwright/test"

export async function discussObject(page: Page, item: Locator, destination?: string) {
  await item.focus()
  await item.locator(".detail-head").click({ button: "right", position: { x: 2, y: 2 } })
  const menu = page.getByRole("menu", { name: "Discussion actions" })
  await expect(menu).toBeVisible()
  await menu.getByRole("menuitem", { name: "Discuss", exact: true }).click()
  const choices = page.getByRole("menu", { name: "Choose chat", exact: true })
  if (await choices.count()) await choices.getByRole("menuitem", { name: destination ? `Discuss in #${destination}` : "New discussion", exact: true }).click()
}
