import { discussObject } from "./support/discussions"
import { expect, test, type Page } from "./support/coverage"

async function createGenericItem(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Window board")
  await create.getByRole("radio", { name: "Blank board" }).check()
  await create.getByRole("button", { name: "Create", exact: true }).click()
  await expect(create).toBeHidden()
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Window source")
  await form.getByLabel("Body", { exact: true }).fill("Inspect this description")
  await form.getByRole("button", { name: "Save item", exact: true }).click()
  await expect(form).toBeHidden()
  return page.getByRole("button", { name: "Open Window source", exact: true })
}

async function openGenericItem(page: Page) {
  await (await createGenericItem(page)).focus()
  await page.keyboard.press("Enter")
  return page.getByRole("dialog", { name: "Item overview", exact: true })
}

test("Given generic item and discussion, when pointer drag and resize then both nonmodal windows stay usable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const item = await openGenericItem(page)
  await expect(item).not.toHaveAttribute("aria-modal", "true")
  await discussObject(page, item)
  const discussion = page.getByRole("dialog", { name: /^Discussion/ })
  await expect(discussion).toBeVisible()
  await expect(discussion.getByRole("button", { name: "Next window", exact: true })).toHaveCount(0)
  await expect(discussion.getByRole("button", { name: /Minimize/i })).toHaveCount(0)
  await expect(discussion.getByRole("button", { name: "Send message", exact: true })).toBeDisabled()
  await discussion.getByRole("button", { name: "Maximize window", exact: true }).click()
  await expect(discussion.locator(".spatial-resize")).toBeDisabled()
  await discussion.getByRole("button", { name: "Restore window size", exact: true }).click()
  await discussion.evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished)) })
  await expect(discussion.getByRole("button", { name: /^Resize/ })).toBeEnabled()
  const before = (await discussion.boundingBox())!
  const titlebar = (await discussion.locator(".spatial-titlebar").boundingBox())!
  await page.mouse.move(titlebar.x + 10, titlebar.y + 18)
  await page.mouse.down()
  await page.mouse.move(titlebar.x + 70, titlebar.y + 58, { steps: 6 })
  await page.mouse.up()
  const moved = (await discussion.boundingBox())!
  expect(moved.x).toBeCloseTo(before.x + 60, 0)
  expect(moved.y).toBeCloseTo(before.y + 40, 0)
  const handle = (await discussion.getByRole("button", { name: /^Resize/ }).boundingBox())!
  await page.mouse.move(handle.x + 36, handle.y + 36)
  await page.mouse.down()
  await page.mouse.move(handle.x + 86, handle.y + 66, { steps: 6 })
  await page.mouse.up()
  const resized = (await discussion.boundingBox())!
  expect(resized.width).toBeCloseTo(moved.width + 50, 0)
  expect(resized.height).toBeCloseTo(moved.height + 30, 0)
  await discussion.getByRole("button", { name: "Close", exact: true }).click()
  await expect(item).toBeFocused()
  await discussObject(page, item)
  expect((await discussion.boundingBox())!.width).toBeCloseTo(resized.width, 0)
})

test("Given overlapping windows, when cycling focus and opening Settings then bounded ring yields to modal", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  const item = await openGenericItem(page)
  await discussObject(page, item)
  const discussion = page.getByRole("dialog", { name: /^Discussion/ })
  await discussion.locator(".spatial-titlebar").focus()
  await page.keyboard.press("Alt+Backquote")
  await expect.poll(() => item.evaluate(element => element.contains(document.activeElement))).toBe(true)
  const itemZ = await item.evaluate(el => Number(getComputedStyle(el).zIndex))
  const discussionZ = await discussion.evaluate(el => Number(getComputedStyle(el).zIndex))
  expect(itemZ).toBeGreaterThan(discussionZ)
  await discussObject(page, item)
  await expect(page.getByRole("dialog", { name: /^Discussion/ })).toHaveCount(1)
  const settingsButton = page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true })
  await settingsButton.focus()
  await page.keyboard.press("Enter")
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(settings).toBeVisible()
  expect(await settings.evaluate(el => el.contains(document.activeElement))).toBe(true)
  expect(await page.locator('[data-window-id^="discussion:"]').evaluate(el => Boolean(el.closest("[inert]")))).toBe(true)
  await page.keyboard.press("Tab")
  expect(await settings.evaluate(el => el.contains(document.activeElement))).toBe(true)
  await page.keyboard.press("Escape")
  await expect(settings).toBeHidden()
  await expect(discussion).toBeVisible()
  await expect(settingsButton).toBeFocused()
})

test("Given narrow touch screen and unsent draft, when closing and reopening discussion then source and draft stay reachable", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  try {
    const page = await context.newPage()
    const item = await openGenericItem(page)
    await discussObject(page, item)
    const discussion = page.getByRole("dialog", { name: /^Discussion/ })
    await expect(discussion.getByRole("textbox", { name: "Message", exact: true })).toBeVisible()
    expect(await discussion.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await expect(discussion.getByRole("button", { name: "Next window", exact: true })).toHaveCount(0)
    await discussion.getByRole("textbox", { name: "Message", exact: true }).fill("Unsent mobile draft")
    await discussion.getByRole("button", { name: "Close", exact: true }).tap()
    await expect(discussion).toBeHidden()
    await expect(item).toBeVisible()
    await discussObject(page, item)
    await expect(discussion.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Unsent mobile draft")
    await discussion.getByRole("button", { name: "Close", exact: true }).tap()
    await expect(item).toBeVisible()
    await item.getByRole("button", { name: "Dismiss", exact: true }).tap()
    await expect(page.getByRole("button", { name: "Open Window source", exact: true })).toBeFocused()
  } finally { await context.close() }
})

test("Given generic description, when keyboard Discuss targets its field then message retains field anchor", async ({ page }) => {
  const item = await openGenericItem(page)
  await item.locator(".detail-copy").click({ button: "right" })
  await page.getByRole("menuitem", { name: "Discuss", exact: true }).focus()
  await page.keyboard.press("Enter")
  const discussion = page.getByRole("dialog", { name: /^Discussion/ })
  await discussion.getByRole("textbox", { name: "Message", exact: true }).fill("Field-level question")
  await discussion.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(discussion.getByText("Field-level question", { exact: true })).toBeVisible()
  await expect(discussion.locator(".chat-message-item").getByRole("button", { name: "Window source · Description", exact: true })).toBeVisible()
})

test("Given tablet touch window, when titlebar and corner gestures move resize and cancel then content keeps native touch behavior", async ({ browser, browserName, baseURL }) => {
  test.skip(browserName !== "chromium", "Touch gesture injection uses Chromium's CDP")
  const context = await browser.newContext({ baseURL, viewport: { width: 1024, height: 844 }, hasTouch: true, isMobile: true })
  try {
    const page = await context.newPage()
    const item = await openGenericItem(page)
    await discussObject(page, item)
    const discussion = page.getByRole("dialog", { name: /^Discussion/ })
    const session = await context.newCDPSession(page)
    async function drag(x: number, y: number, dx: number, dy: number, cancel = false) {
      const point = (x: number, y: number) => ({ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 })
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(x, y)] })
      for (let step = 1; step <= 6; step++) {
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(x + dx * step / 6, y + dy * step / 6)] })
      }
      await session.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] })
    }
    const before = (await discussion.boundingBox())!
    const titlebar = (await discussion.locator(".spatial-titlebar").boundingBox())!
    await drag(titlebar.x + 10, titlebar.y + 18, 40, 20)
    const moved = (await discussion.boundingBox())!
    expect(moved.x).toBeCloseTo(before.x + 40, 0)
    expect(moved.y).toBeCloseTo(before.y + 20, 0)
    const handle = (await discussion.getByRole("button", { name: /^Resize/ }).boundingBox())!
    await drag(handle.x + 36, handle.y + 36, 30, 10, true)
    const resized = (await discussion.boundingBox())!
    expect(resized.width).toBeCloseTo(moved.width + 30, 0)
    expect(resized.height).toBeCloseTo(moved.height + 10, 0)
    expect(await discussion.locator(".spatial-body").evaluate(el => getComputedStyle(el).touchAction)).toBe("auto")
    await discussion.getByRole("textbox", { name: "Message", exact: true }).fill("Touch draft survives")
    await discussion.getByRole("button", { name: "Close", exact: true }).tap()
    await discussObject(page, item)
    await expect(discussion.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Touch draft survives")
    expect((await discussion.boundingBox())!.width).toBeCloseTo(resized.width, 0)
    await session.detach()
  } finally { await context.close() }
})

test("Given workspace A windows and separate B item, when switching back then A content and geometry restore without B leakage", async ({ page }) => {
  const item = await openGenericItem(page)
  await item.locator(".spatial-titlebar").focus()
  await page.keyboard.press("ArrowRight")
  const itemGeometry = (await item.boundingBox())!
  await discussObject(page, item)
  const discussion = page.getByRole("dialog", { name: /^Discussion/ })
  await discussion.getByRole("textbox", { name: "Message", exact: true }).fill("Workspace A draft")
  await discussion.locator(".spatial-titlebar").focus()
  await page.keyboard.press("ArrowLeft")
  const conversationGeometry = (await discussion.boundingBox())!
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Other window board")
  await create.getByRole("radio", { name: "Blank board" }).check()
  await create.getByRole("button", { name: "Create", exact: true }).click()
  await expect(create).toBeHidden()
  await expect(discussion).toHaveCount(0)
  await expect(item).toHaveCount(0)
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Other workspace item")
  await form.getByRole("button", { name: "Save item", exact: true }).click()
  await page.getByRole("button", { name: "Open Other workspace item", exact: true }).click()
  await expect(item).toContainText("Other workspace item")
  await discussObject(page, item)
  await expect(discussion.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  const workspaces = page.getByRole("dialog", { name: "Workspaces", exact: true })
  await workspaces.getByRole("button", { name: /^Window board Owner:/ }).click()
  await expect(workspaces).toBeHidden()
  await expect(item).toContainText("Window source")
  await expect(item).not.toContainText("Other workspace item")
  await expect(discussion.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Workspace A draft")
  const restoredItem = (await item.boundingBox())!
  const restoredConversation = (await discussion.boundingBox())!
  expect(restoredItem.x).toBeCloseTo(itemGeometry.x, 0)
  expect(restoredItem.width).toBeCloseTo(itemGeometry.width, 0)
  expect(restoredConversation.x).toBeCloseTo(conversationGeometry.x, 0)
})
