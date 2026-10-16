import { expect, test } from "./support/coverage"

for (const width of [390, 1440]) test(`Given a ${width}px board and empty chat, When keyboard focus moves across controls, Then focus stays visible on window controls, disclosure and message links`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  await page.goto("/")
  const search = page.getByRole("searchbox", { name: "Search cards" })
  await search.focus()
  await expect(search).toBeFocused()
  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await expect(chat.getByRole("button", { name: "Send message" })).toBeDisabled()
  const titlebar = chat.locator(".spatial-titlebar")
  await page.keyboard.press("Tab")
  await titlebar.focus()
  await expect(titlebar).toHaveCSS("outline-style", "solid")
  if (width < 600) {
    await chat.getByRole("button", { name: "Add reference or participant", exact: true }).focus()
    await page.keyboard.press("Enter")
  }
  const summary = chat.locator(".mention-picker summary")
  await summary.focus()
  await expect(summary).toHaveCSS("outline-style", "solid")
  if (width < 600) {
    await chat.getByRole("button", { name: "Add reference or participant", exact: true }).click()
    await page.keyboard.press("Tab")
  }
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("[Board documentation](https://example.com/docs)")
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.locator(".chat-message-pending")).toHaveCount(0)
  const link = chat.getByRole("link", { name: "Board documentation" })
  await page.keyboard.press("Tab")
  await link.focus()
  await expect(link).toHaveCSS("outline-style", "solid")
})
