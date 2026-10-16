import { expect, test, type Locator } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function angle(locator: Locator) {
  return locator.evaluate(element => {
    const matrix = new DOMMatrix(getComputedStyle(element).transform)
    return Math.atan2(matrix.b, matrix.a) * 180 / Math.PI
  })
}

async function transformOffset(locator: Locator) {
  return locator.evaluate(element => {
    const transform = new DOMMatrix(getComputedStyle(element).transform)
    return { x: transform.e, y: transform.f }
  })
}

test("Given paper buttons and cards, when hovered, then controls stay steady and clicking still opens the card", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.goto("/")
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  await form.getByLabel("Title *").fill("Paper card")
  const save = form.getByRole("button", { name: "Save item", exact: true })
  const saveBefore = await save.boundingBox()
  await save.hover()
  expect(await angle(save)).toBe(0)
  expect(await transformOffset(save)).toEqual({ x: 0, y: 0 })
  const saveAfter = await save.boundingBox()
  expect(saveAfter).not.toBeNull()
  expect(saveBefore).not.toBeNull()
  expect(Math.abs(saveAfter!.x - saveBefore!.x)).toBeLessThan(1)
  await save.click()
  const card = page.locator(".lead-card").filter({ hasText: "Paper card" })
  await card.hover()
  await expect.poll(async () => Math.abs(await angle(card))).toBeGreaterThan(1)
  await page.screenshot({ path: info.outputPath("paper-card-hover.png") })
  await card.getByRole("button", { name: "Open Paper card", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Item overview", exact: true })).toBeVisible()

  await page.getByRole("button", { name: "Close detail", exact: true }).click()
  await page.emulateMedia({ reducedMotion: "reduce" })
  await card.hover()
  expect(await angle(card)).toBe(0)
})

test("Given local device details and recovery words, when viewed or restore fails, then technical text remains readable in Fira Code", async ({ page }, info) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const sync = page.getByRole("dialog", { name: "Device sync", exact: true })
  await expect(sync).toBeVisible()
  const members = sync.getByRole("list", { name: "Mesh members" })
  const memberButtons = members.getByRole("button")
  // The current device loads asynchronously even without connected peers.
  await expect(memberButtons.first()).toBeVisible()
  await memberButtons.first().click()
  const deviceId = sync.locator(".mesh-device-head code")
  await expect(deviceId).toHaveCSS("font-family", /Fira Code/)
  await expect(deviceId).toHaveCSS("font-variant-ligatures", "none")
  await sync.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Identity", exact: true }).click()
  await settings.getByRole("button", { name: "Recovery backup", exact: true }).click()
  const recovery = page.getByRole("dialog", { name: "Identity recovery", exact: true })
  await recovery.getByRole("button", { name: "Restore from backup", exact: true }).click()
  const words = recovery.getByRole("textbox", { name: "Recovery words", exact: true })
  await words.fill("IIl10 O0 abcdef0123456789")
  await expect(words).toHaveCSS("font-family", /Fira Code/)
  const loadedFonts = await page.evaluate(async () => (await document.fonts.load(
    '400 15px "Fira Code"', "IIl10 O0 abcdef0123456789",
  )).map(font => font.status))
  expect(loadedFonts.length).toBeGreaterThan(0)
  expect(loadedFonts.every(status => status === "loaded")).toBe(true)
  expect(await page.evaluate(() => document.fonts.check('400 15px "Fira Code"'))).toBe(true)
  const restore = recovery.getByRole("button", { name: "Restore identity", exact: true })
  await restore.hover({ force: true })
  expect(await angle(restore)).toBe(0)
  await recovery.getByLabel("Recovery file").setInputFiles({ name: "invalid-recovery.json", mimeType: "application/json", buffer: Buffer.from("{}") })
  await recovery.getByRole("checkbox").check()
  await expect(restore).toBeDisabled()
  await expect(recovery.getByRole("alert")).toBeVisible()
  await expect(words).toHaveValue("IIl10 O0 abcdef0123456789")
  await page.screenshot({ path: info.outputPath("technical-type-failure.png") })
})
