import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

type AvatarFailureWindow = Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }

async function portraitFixture(page: import("@playwright/test").Page) {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = 512
    canvas.height = 256
    const context = canvas.getContext("2d")!
    context.fillStyle = "#ef4444"
    context.fillRect(0, 0, 256, 256)
    context.fillStyle = "#2563eb"
    context.fillRect(256, 0, 256, 256)
    context.fillStyle = "#fde047"
    context.beginPath()
    context.arc(256, 128, 56, 0, Math.PI * 2)
    context.fill()
    return canvas.toDataURL("image/png")
  })
  return Buffer.from(dataUrl.split(",")[1]!, "base64")
}

async function openAvatarSettings(page: import("@playwright/test").Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Settings" }).click()
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("tab", { name: "Identity", exact: true }).click()
  await expect(page.getByRole("region", { name: "Identity photo" })).toBeVisible()
}

test("Given photo settings, when the crop window cannot load, then reload recovery is visible and a reselected photo survives saving", async ({ page }) => {
  await openAvatarSettings(page)
  const cropModule = "**/src/components/AvatarCropDialog.vue*"
  await page.route(cropModule, route => route.abort())
  await page.getByLabel("Choose photo").setInputFiles({
    name: "portrait.png", mimeType: "image/png", buffer: await portraitFixture(page),
  })
  const photo = page.getByRole("region", { name: "Identity photo" })
  await expect(photo.getByRole("alert")).toContainText("Photo editor could not load")
  await expect(photo.getByRole("button", { name: "Reload app", exact: true })).toBeVisible()
  await page.unroute(cropModule)
  await photo.getByRole("button", { name: "Reload app", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByLabel("Choose photo").setInputFiles({
    name: "portrait.png", mimeType: "image/png", buffer: await portraitFixture(page),
  })
  const crop = page.getByRole("dialog", { name: "Crop profile photo" })
  await crop.getByRole("button", { name: "Save photo", exact: true }).click()
  await expect(photo.getByRole("img", { name: "Your profile photo" })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByRole("img", { name: "Your profile photo" })).toBeVisible()
})

test("Given identity photo settings, when one crop is saved and another workspace opens, then the same photo appears immediately and survives reload", async ({ page }) => {
  await openAvatarSettings(page)
  await page.getByLabel("Choose photo").setInputFiles({
    name: "portrait.png", mimeType: "image/png", buffer: await portraitFixture(page),
  })

  const crop = page.getByRole("dialog", { name: "Crop profile photo" })
  const window = crop.locator(".avatar-crop-frame")
  const box = await window.boundingBox()
  if (!box) throw new Error("Crop window unavailable")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 24, box.y + box.height / 2 - 12)
  await page.mouse.up()
  await crop.getByRole("slider", { name: "Photo zoom" }).fill("1.5")
  await crop.getByRole("button", { name: "Save photo" }).first().click()
  await expect(page.getByRole("img", { name: "Your profile photo" })).toBeVisible()

  const saved = page.locator(".participant-avatar-photo")
  await expect(saved).toBeVisible()
  const source = await saved.getAttribute("src")
  expect(source).toMatch(/^data:image\/(webp|jpeg);base64,/)
  expect(source!.length).toBeLessThanOrEqual(22_000)
  await expect(page.getByRole("button", { name: "Save photo" })).toHaveCount(0)
  await page.reload()
  await page.getByRole("button", { name: "Settings" }).click()
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("tab", { name: "Identity", exact: true }).click()
  await expect(page.locator(".identity-avatar-preview")).toHaveAttribute("src", source!)
  await page.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Dismiss" }).click()
  await page.getByRole("button", { name: "Open workspaces" }).click()
  const originalTitle = await page.locator(".workspace-switch strong").first().innerText()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title").fill("Other photo scope")
  await create.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const otherSettings = page.getByRole("dialog", { name: "Settings", exact: true })
  await otherSettings.getByRole("tab", { name: "Identity", exact: true }).click()
  await expect(otherSettings.getByRole("region", { name: "Identity photo" })).toBeVisible()
  await expect(otherSettings.locator(".identity-avatar-preview")).toHaveAttribute("src", source!)
  await otherSettings.getByRole("button", { name: "Dismiss" }).click()
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.locator(".workspace-switch").filter({ hasText: originalTitle }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const originalSettings = page.getByRole("dialog", { name: "Settings", exact: true })
  await originalSettings.getByRole("tab", { name: "Identity", exact: true }).click()
  await expect(originalSettings.locator(".identity-avatar-preview")).toHaveAttribute("src", source!)
  await originalSettings.getByRole("button", { name: "Remove photo", exact: true }).click()
  await expect(originalSettings.locator(".identity-avatar-preview")).toHaveCount(0)
  await originalSettings.getByRole("button", { name: "Dismiss" }).click()
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.locator(".workspace-switch").filter({ hasText: "Other photo scope" }).click()
  await page.reload()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByRole("region", { name: "Identity photo" }).locator(".identity-avatar-preview")).toHaveCount(0)
})

test("Given a photo draft, when file decode or save fails, then current avatar stays and draft can retry", async ({ page }) => {
  await openAvatarSettings(page)
  const input = page.getByLabel("Choose photo")
  await input.setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not an image") })
  await expect(page.getByRole("alert")).toContainText("could not be decoded")

  await input.setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: await portraitFixture(page) })
  const crop = page.getByRole("dialog", { name: "Crop profile photo" })
  await page.evaluate(() => { (window as AvatarFailureWindow).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
  await crop.getByRole("button", { name: "Save photo" }).first().click()
  await expect(page.getByRole("alert")).toContainText("Storage failure injected")
  await expect(page.getByRole("img", { name: "Your profile photo" })).toBeVisible()

  await page.evaluate(() => { (window as AvatarFailureWindow).__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })
  await page.getByRole("button", { name: "Retry save", exact: true }).click()
  await expect(page.locator(".participant-avatar-photo")).toBeVisible()
})

test("Given a visitor joins a workspace, when they save their avatar, then owner receives the CRDT profile", async ({ page, browser }) => {
  test.setTimeout(90_000)
  const guestContext = await browser.newContext()
  const guest = await guestContext.newPage()
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const ownerDialog = page.getByRole("dialog", { name: "Device sync" })
    await ownerDialog.getByRole("button", { name: "Add someone" }).click()
    await ownerDialog.getByRole("button", { name: "Generate link" }).click()
    await guest.goto(await ownerDialog.getByLabel("Pairing link").inputValue())
    const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
    await guestDialog.getByRole("button", { name: "Accept and join" }).click()
    await ownerDialog.getByRole("button", { name: "Approve access" }).click()
    await expect(guestDialog.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
    await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()
    const ownerClose = ownerDialog.getByRole("button", { name: "Close", exact: true }).first()
    if (await ownerClose.isVisible().catch(() => false)) await ownerClose.click()

    await openAvatarSettings(guest)
    await guest.getByLabel("Choose photo").setInputFiles({
      name: "visitor.png", mimeType: "image/png", buffer: await portraitFixture(guest),
    })
    const crop = guest.getByRole("dialog", { name: "Crop profile photo" })
    await crop.getByRole("button", { name: "Save photo" }).first().click()
    const image = guest.locator(".identity-avatar-preview")
    await expect(image).toBeVisible()
    const source = await image.getAttribute("src")
    expect(source).toBeTruthy()
    await expect(guest.getByRole("button", { name: "Save photo" })).toHaveCount(0)

    const currentOwnerClose = page.getByRole("dialog", { name: "Device sync" })
      .getByRole("button", { name: "Close", exact: true }).first()
    if (await currentOwnerClose.isVisible().catch(() => false)) await currentOwnerClose.click()
    await page.getByRole("button", { name: "Settings" }).click()
    const settings = page.getByRole("dialog", { name: "Settings" })
    await settings.getByRole("tab", { name: "Connections", exact: true }).click()
    await settings.getByRole("button", { name: "Open Device sync", exact: true }).click()
    await expect.poll(async () => page.locator(".mesh-member .participant-avatar-photo").evaluateAll((images, expectedSource) =>
      images.some(image => (image as HTMLImageElement).src === expectedSource), source), { timeout: 30_000 }).toBe(true)
  } finally {
    await guestContext.close()
  }
})
