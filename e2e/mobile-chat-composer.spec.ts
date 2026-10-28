import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test("Given mobile chat, When typing with saved history, Then messages own the height and existing timestamps are not reformatted per keystroke", async ({ page }, info) => {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Compact chat")
  await page.getByRole("button", { name: "Workspace chat", exact: true }).click()
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await expect(chat).toBeVisible()
  await expect(chat.getByRole("button", { name: "Maximize window" })).toBeHidden()
  await expect(chat.getByRole("button", { name: "Restore window size" })).toBeHidden()
  const composer = chat.getByRole("textbox", { name: "Message", exact: true })
  const log = chat.getByRole("log", { name: "Messages" })
  expect((await log.boundingBox())!.height).toBeGreaterThan((await chat.boundingBox())!.height * .7)
  await expect(chat.getByText("Invite @participant", { exact: true })).toHaveCount(0)
  await expect(chat.getByText("Attach item reference", { exact: true })).toHaveCount(0)
  await composer.fill("Saved mobile message")
  await chat.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(log.getByText("Saved mobile message", { exact: true })).toBeVisible()
  await expect(log.getByText("Saving locally…")).toHaveCount(0)
  const timestamp = await log.locator("time").first().getAttribute("datetime")
  await page.evaluate(timestamp => {
    const original = Date.prototype.toLocaleDateString
    const expected = new Date(timestamp!).getTime()
    const state = window as Window & { __messageDateFormats?: number }
    state.__messageDateFormats = 0
    Date.prototype.toLocaleDateString = function (...args) {
      if (this.getTime() === expected) state.__messageDateFormats!++
      return Reflect.apply(original, this, args)
    }
  }, timestamp)
  await composer.pressSequentially("Typing should leave history alone")
  expect(await page.evaluate(() => (window as Window & { __messageDateFormats?: number }).__messageDateFormats)).toBe(0)
  await expect(composer).toHaveValue("Typing should leave history alone")
  await page.setViewportSize({ width: 390, height: 540 })
  await expect(chat.getByRole("button", { name: "Send message", exact: true })).toBeInViewport()
  expect((await log.boundingBox())!.height).toBeGreaterThan(260)
  await page.screenshot({ path: info.outputPath("compact-mobile-chat.png") })
  await chat.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(log.getByText("Typing should leave history alone", { exact: true })).toBeVisible()
})
