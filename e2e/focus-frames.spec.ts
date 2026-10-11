import { expect, test, type Page } from "./support/coverage"

async function expectNoBlueFrames(page: Page) {
  const blueFrames = await page.locator("body *").evaluateAll(elements => elements.flatMap(element => {
    const style = getComputedStyle(element)
    if (!element.getClientRects().length || style.visibility === "hidden") return []
    const strokes = [
      [style.outlineWidth, style.outlineStyle, style.outlineColor],
      [style.borderTopWidth, style.borderTopStyle, style.borderTopColor],
      [style.borderRightWidth, style.borderRightStyle, style.borderRightColor],
      [style.borderBottomWidth, style.borderBottomStyle, style.borderBottomColor],
      [style.borderLeftWidth, style.borderLeftStyle, style.borderLeftColor],
    ]
    return strokes.some(([width, kind, color]) => {
      const [red = 0, green = 0, blue = 0, alpha = 1] = color!.match(/[\d.]+/g)?.map(Number) ?? []
      return parseFloat(width!) > 0 && kind !== "none" && alpha > 0 && blue > red + 25 && blue > green + 25
    }) ? [`${element.tagName}.${element.getAttribute("class") ?? ""}`] : []
  }))
  expect(blueFrames).toEqual([])
}

for (const width of [390, 1440]) test(`Given a ${width}px board and empty chat, When keyboard focus moves across controls, Then paper frames stay neutral and focus stays visible without browser blue outlines`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  await page.goto("/")
  const search = page.getByRole("searchbox", { name: "Search cards" })
  await search.focus()
  await expectNoBlueFrames(page)
  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await expect(chat.getByRole("button", { name: "Send message" })).toBeDisabled()
  const titlebar = chat.locator(".spatial-titlebar")
  await page.keyboard.press("Tab")
  await titlebar.focus()
  await expect(titlebar).toHaveCSS("outline-style", "solid")
  await expect(titlebar).toHaveCSS("outline-color", "rgb(23, 107, 77)")
  await expectNoBlueFrames(page)
  const summary = chat.locator(".mention-picker summary")
  await summary.focus()
  await expect(summary).toHaveCSS("outline-style", "solid")
  await expect(summary).toHaveCSS("outline-color", "rgb(23, 107, 77)")
  await expectNoBlueFrames(page)
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("[Board documentation](https://example.com/docs)")
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.locator(".chat-message-pending")).toHaveCount(0)
  const link = chat.getByRole("link", { name: "Board documentation" })
  await page.keyboard.press("Tab")
  await link.focus()
  await expect(link).toHaveCSS("outline-style", "solid")
  await expect(link).toHaveCSS("outline-color", "rgb(23, 107, 77)")
  await expectNoBlueFrames(page)
})
