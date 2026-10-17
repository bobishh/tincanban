import { expect, test, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function openChat(page: Page) {
  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  return page.getByRole("dialog", { name: "Workspace chat", exact: true })
}

async function profileSettings(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByRole("button", { name: "Menu", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
  await dialog.getByRole("tab", { name: "Identity" }).click()
  return dialog
}

test("Given Markdown cannot load, when a chat message is saved, then its text remains visible", async ({ page }) => {
  await page.route("**/src/components/MarkdownContent.vue", route => route.abort())
  await page.goto("/")
  const chat = await openChat(page)
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Visible despite unavailable formatting")
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.getByText("Visible despite unavailable formatting", { exact: true })).toBeVisible()
  await expect(chat.getByText("Saving locally…", { exact: true })).toHaveCount(0)
  await expect(chat.getByText("Visible despite unavailable formatting", { exact: true })).toBeVisible()
  await page.reload()
  const restored = await openChat(page)
  await expect(restored.getByText("Visible despite unavailable formatting", { exact: true })).toBeVisible()
})

for (const width of [1280, 375]) {
  test(`Given a ${width}px workspace, when I name myself and send a message, then both persist after reload`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    let settings = await profileSettings(page)
    await expect(settings.getByRole("textbox", { name: "Name", exact: true })).not.toHaveValue("")
    await settings.getByRole("textbox", { name: "Name", exact: true }).fill("Тревожная мимоза")
    await settings.getByRole("button", { name: "Save profile", exact: true }).click()
    await expect(settings.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Тревожная мимоза")
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
    let chat = await openChat(page)
    if (width === 375) await expect(chat.getByRole("button", { name: "Resize chat" })).toHaveCount(0)
    await expect(chat.getByRole("button", { name: "Send message" })).toBeDisabled()
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Hello workspace <script>alert(1)</script>")
    await chat.getByRole("button", { name: "Send message" }).click()
    await expect(chat.getByText("Hello workspace <script>alert(1)</script>", { exact: true })).toBeVisible()
    await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("")
    await expect(chat.locator(".chat-message-author")).toHaveText("Тревожная мимоза")
    // The optimistic row appears before IndexedDB persistence finishes. Wait
    // for its pending marker to clear before reloading the page.
    await expect(chat.locator(".chat-message-pending")).toHaveCount(0)
    const geometry = await chat.evaluate(el => ({ width: el.clientWidth, content: el.scrollWidth }))
    expect(geometry.content).toBeLessThanOrEqual(geometry.width)
    await page.reload()
    chat = await openChat(page)
    await expect(chat.getByText("Hello workspace <script>alert(1)</script>", { exact: true })).toBeVisible()
    await chat.getByRole("button", { name: "Close", exact: true }).click()
    settings = await profileSettings(page)
    await expect(settings.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Тревожная мимоза")
  })
}

test("Given two messages across midnight, when chat renders them on mobile, then each date and time stays distinct", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 820 })
  await page.goto("/")
  const chat = await openChat(page)
  async function sendAt(body: string, timestamp: string) {
    await page.evaluate(value => {
      const original = Date.prototype.toISOString
      ;(window as Window & { __restoreDateFormatting?: () => void }).__restoreDateFormatting = () => { Date.prototype.toISOString = original }
      Date.prototype.toISOString = () => value
    }, timestamp)
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill(body)
    await chat.getByRole("button", { name: "Send message" }).click()
    await expect(chat.getByText(body, { exact: true })).toBeVisible()
    await expect(chat.locator(".chat-message-pending")).toHaveCount(0)
    await page.evaluate(() => (window as Window & { __restoreDateFormatting?: () => void }).__restoreDateFormatting?.())
  }
  const [beforeMidnight, afterMidnight] = await page.evaluate(() => [
    new Date(2026, 9, 6, 23, 52).toISOString(), new Date(2026, 9, 7, 0, 9).toISOString(),
  ])
  await sendAt("Late message", beforeMidnight!)
  await sendAt("After midnight", afterMidnight!)
  const times = chat.locator(".chat-message-item time")
  await expect(times).toHaveCount(2)
  const timestamps = await times.evaluateAll(elements => elements.map(element => element.getAttribute("datetime") ?? ""))
  expect([...timestamps].sort()).toEqual([beforeMidnight!, afterMidnight!].sort())
  const renderedDates = await page.evaluate(values => values.map(value =>
    new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })), timestamps)
  const labels = await times.allTextContents()
  expect(labels[0]).toContain(renderedDates[0]!)
  expect(labels[1]).toContain(renderedDates[1]!)
  expect(renderedDates[0]).not.toBe(renderedDates[1])
  const geometry = await chat.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }))
  expect(geometry.scroll).toBeLessThanOrEqual(geometry.width)
})

test("Given a chosen profile name, when a new workspace is created, then it reuses the personal name preset", async ({ page }) => {
  await page.goto("/")
  let settings = await profileSettings(page)
  await settings.getByRole("textbox", { name: "Name", exact: true }).fill("Тревожная мимоза")
  await settings.getByRole("button", { name: "Save profile", exact: true }).click()
  await expect(settings.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Тревожная мимоза")
  await settings.getByRole("button", { name: "Dismiss", exact: true }).click()

  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title").fill("Second board")

  await create.getByRole("button", { name: "Create" }).click()

  settings = await profileSettings(page)
  await expect(settings.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Тревожная мимоза")
  await page.reload()
  settings = await profileSettings(page)
  await expect(settings.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Тревожная мимоза")
})

test("Given desktop chat, when its corner is dragged, then the window resizes within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/")
  const chat = await openChat(page)
  const handle = chat.getByRole("button", { name: "Resize chat" })
  await expect(handle).toBeVisible()
  const before = await chat.boundingBox()
  expect(before).not.toBeNull()

  const grip = await handle.boundingBox()
  expect(grip).not.toBeNull()
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2)
  await page.mouse.down()
  await page.mouse.move(before!.x + before!.width + 100, before!.y + before!.height + 80, { steps: 6 })
  await page.mouse.up()

  const after = await chat.boundingBox()
  expect(after).not.toBeNull()
  expect(after!.width).toBeGreaterThan(before!.width + 60)
  expect(after!.height).toBeGreaterThan(before!.height + 40)
  expect(after!.x + after!.width).toBeLessThanOrEqual(1280)
  expect(after!.y + after!.height).toBeLessThanOrEqual(900)
})

test("Given a storage failure, when a message is submitted, then the draft remains and retry writes once", async ({ page }) => {
  await page.goto("/")
  const settings = await profileSettings(page)
  await expect(settings.getByRole("textbox", { name: "Name", exact: true })).not.toHaveValue("")
  await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
  const chat = await openChat(page)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    ;(window as any).__restoreChatPut = () => { IDBObjectStore.prototype.put = original }
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === "messages") throw new DOMException("Storage full", "QuotaExceededError")
      return original.apply(this, args)
    }
  })
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Keep my draft")
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.getByRole("alert")).toContainText("Storage full")
  await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep my draft")
  await expect(chat.locator(".chat-message-body")).toHaveCount(0)
  await page.evaluate(() => (window as any).__restoreChatPut())
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.locator(".chat-message-body")).toHaveText("Keep my draft")
  await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("")
})

test("Given slow local signing, when a message is submitted, then it appears immediately while durability finishes", async ({ page }) => {
  await page.goto("/")
  const chat = await openChat(page)
  await page.evaluate(() => {
    const original = SubtleCrypto.prototype.sign
    ;(window as any).__restoreChatSign = () => { SubtleCrypto.prototype.sign = original }
    SubtleCrypto.prototype.sign = async function (...args: Parameters<SubtleCrypto["sign"]>) {
      await new Promise(resolve => setTimeout(resolve, 2_000))
      return original.apply(this, args)
    }
  })
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Local-first message")
  await chat.getByRole("button", { name: "Send message" }).click()

  await expect(chat.getByText("Local-first message", { exact: true })).toBeVisible({ timeout: 300 })
  await expect(chat.getByText("Saving locally…", { exact: true })).toBeVisible()
  await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("")
  await expect(chat.getByText("Saving locally…", { exact: true })).toHaveCount(0, { timeout: 10_000 })
  await page.evaluate(() => (window as any).__restoreChatSign())
})

test("Given one poisoned historical chat record, when a peer sends it with a valid record, then the valid message still arrives", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const result = await page.evaluate(async () => {
    const servicePath = "/src/chat/service.ts"
    const statePath = "/src/state.ts"
    const service = await import(/* @vite-ignore */ servicePath)
    const state = await import(/* @vite-ignore */ statePath)
    const workspaceId = state.useTincanban().activeWorkspace.id
    await service.sendChatMessage(workspaceId, "Valid sibling record")
    const wire = await service.exportChat(workspaceId)
    const valid = structuredClone(wire.messages.at(-1))
    const poisoned = structuredClone(valid)
    poisoned.authority.grant = {
      payload: { kind: "workspace-grant", version: 1, workspaceId,
        personId: poisoned.signed.payload.personId, role: "editor", issuedAt: new Date().toISOString() },
      signerKeyId: poisoned.signed.payload.deviceId,
      signature: poisoned.signed.signature,
    }
    try {
      await service.receiveChat(workspaceId, { version: 1, profiles: [], messages: [poisoned, valid], typing: [] }, false)
      return { error: "" }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  expect(result.error).toBe("")
  const chat = await openChat(page)
  await expect(chat.getByText("Valid sibling record", { exact: true })).toBeVisible()
})
