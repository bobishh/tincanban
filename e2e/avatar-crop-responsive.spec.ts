import { expect, test } from "./support/coverage"

async function portraitFixture(page: import("@playwright/test").Page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 512
    canvas.height = 256
    const context = canvas.getContext("2d")!
    context.fillStyle = "#e5484d"
    context.fillRect(0, 0, 256, 256)
    context.fillStyle = "#3e63dd"
    context.fillRect(256, 0, 256, 256)
    return canvas.toDataURL("image/png")
  })
  return Buffer.from(dataUrl.split(",")[1]!, "base64")
}

test("Given a narrow mobile viewport, when cropping a wide photo, then preview scale matches saved square bounds", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.goto("/")
  await page.getByRole("button", { name: "Menu", exact: true }).click()
  await page.getByRole("dialog", { name: "Navigation menu" }).getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("tab", { name: "Identity", exact: true }).click()
  await page.getByLabel("Choose photo").setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: await portraitFixture(page) })

  const crop = page.getByRole("dialog", { name: "Crop profile photo" })
  const frame = crop.locator(".avatar-crop-frame")
  await expect(frame).toBeVisible()
  await expect.poll(() => frame.evaluate(element => element.clientWidth)).toBeGreaterThan(0)
  const geometry = await frame.evaluate(element => {
    const image = element.querySelector<HTMLImageElement>(".avatar-crop-image")!
    const style = getComputedStyle(image)
    const contentWidth = element.clientWidth
    return { contentWidth, imageWidth: parseFloat(style.width), imageHeight: parseFloat(style.height), imageLeft: parseFloat(style.left), imageTop: parseFloat(style.top) }
  })

  expect(geometry.contentWidth).toBeLessThan(256)
  expect(Math.abs(geometry.imageWidth - geometry.contentWidth * 2)).toBeLessThan(2)
  expect(Math.abs(geometry.imageHeight - geometry.contentWidth)).toBeLessThan(2)
  expect(Math.abs(geometry.imageLeft + geometry.contentWidth / 2)).toBeLessThan(2)
  expect(Math.abs(geometry.imageTop)).toBeLessThan(1)
  await expect(crop.getByRole("button", { name: "Use photo" })).toBeEnabled()
})
