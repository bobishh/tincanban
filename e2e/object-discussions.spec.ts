import { discussObject } from "./support/discussions"
import { expect, test, type Page } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

async function createItem(page: Page) {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Discussion board")
  await page.getByRole("button", { name: "Add lead to Lead", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Add item" })
  await form.getByLabel("Company *").fill("Anchor Labs")
  await form.getByLabel("Role *").fill("Engineer")
  await form.getByLabel("Description", { exact: true }).fill("Offer: 80k plus equity. Ask about vesting.")
  await form.getByRole("button", { name: "Create item" }).click()
  await expect(form).toBeHidden()
  if (!await page.getByRole("dialog", { name: "Item overview" }).isVisible()) await page.getByRole("button", { name: /Open Anchor Labs/ }).click()
  await expect(page.getByRole("dialog", { name: "Item overview" }).locator(".detail-copy p").first()).toBeVisible()
  return page.getByRole("dialog", { name: "Item overview" })
}

async function send(page: Page, body: string) {
  const discussion = page.getByRole("dialog", { name: /^Discussion/ }).last()
  await discussion.getByRole("textbox", { name: "Message", exact: true }).fill(body)
  await discussion.getByRole("button", { name: "Send message" }).click()
  await expect(discussion.getByText("Saving locally…", { exact: true })).toHaveCount(0)
  await expect(discussion.getByText(body, { exact: true })).toBeVisible()
  return discussion
}

test("Given an idle board, when workspace chat opens, then conversation UI loads on demand", async ({ page }) => {
  const conversationLayerRequests: string[] = []
  page.on("request", request => {
    if (request.url().includes("ObjectConversationLayer.vue")) conversationLayerRequests.push(request.url())
  })
  await page.goto("/")
  await createJobSearchWorkspace(page, "Lazy conversation board")
  await expect(page.getByRole("button", { name: "Add lead to Lead", exact: true })).toBeVisible()
  expect(conversationLayerRequests).toHaveLength(0)

  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  await expect(page.getByRole("dialog", { name: "Workspace chat", exact: true })).toBeVisible()
  expect(conversationLayerRequests.filter(url => !url.includes("?vue&type=style"))).toHaveLength(1)
})

test("Given an offline discussion with an incompatible known peer, when sending, then signed context saves locally and survives reload", async ({ page, context }) => {
  const item = await createItem(page)
  await discussObject(page, item)
  await expect(page.getByRole("dialog", { name: /^Discussion/ }).getByRole("textbox", { name: "Message", exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const service = await import("/src/chat/service.ts")
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    await service.receiveChat(state.activeWorkspace.id, { version: 1, messages: [], profiles: [] }, false, "legacy-offline-peer")
  })
  await context.setOffline(true)
  await send(page, "Saved without a compatible peer")
  await context.setOffline(false)
  const saved = await page.evaluate(async () => {
    const service = await import("/src/chat/service.ts")
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const snapshot = await service.loadChat(state.activeWorkspace.id)
    const message = snapshot.messages.find(value => value.body === "Saved without a compatible peer")!
    const legacy = await service.exportChat(state.activeWorkspace.id, new Set(), "legacy-offline-peer")
    return { message, legacy }
  })
  expect(saved.message.context?.references).toHaveLength(1)
  expect(saved.legacy.upgradeRequired).toBe(true)
  expect(saved.legacy.messages).not.toContainEqual(saved.message.record)
  await page.reload()
  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  await expect(page.getByRole("dialog", { name: "Workspace chat", exact: true }).getByText("Saved without a compatible peer", { exact: true })).toBeVisible()
})

for (const width of [1280, 1024, 390]) {
  test(`Given an item at ${width}px, when Discuss sends and replies, then one message lives in item discussion and global chat`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    const item = await createItem(page)
    await discussObject(page, item)
    const discussion = await send(page, "What is the vesting?")
    await discussion.getByRole("button", { name: "Reply to message", exact: true }).click()
    await send(page, "Four years")
    await expect(page.getByRole("dialog", { name: "Discussion · replies", exact: true }).getByRole("button", { name: "Reply to message" })).toHaveCount(0)
    await send(page, "One year cliff?")
    await expect(page.getByRole("dialog", { name: "Discussion · replies", exact: true }).locator(".chat-message-item")).toHaveCount(3)
    await expect(page.getByRole("dialog", { name: "Discussion · replies", exact: true }).locator(".chat-message-item .reply-quote")).toHaveCount(0)
    await expect(page.getByRole("dialog", { name: "Discussion · replies", exact: true }).locator(".chat-message-item.is-reply .reference-chips button")).toHaveCount(0)
    await page.getByRole("dialog", { name: "Discussion · replies", exact: true }).getByRole("button", { name: "Close", exact: true }).click()
    await expect(discussion.locator(".chat-message-item")).toHaveCount(1)
    await discussion.getByRole("button", { name: "Close", exact: true }).click()
    await item.getByRole("button", { name: "Close detail", exact: true }).click()
    await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
    const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
    await expect(chat.locator(".chat-message-item")).toHaveCount(1)
    await expect(chat.getByRole("button", { name: "2 replies", exact: true })).toHaveCount(1)
    await expect(chat.getByRole("button", { name: "Reply to message" })).toHaveCount(0)
    await chat.getByRole("button", { name: "2 replies", exact: true }).click()
    const thread = page.getByRole("dialog", { name: "Discussion · replies", exact: true })
    await expect(thread.locator(".chat-message-item")).toHaveCount(3)
    await expect(thread.locator(".reply-quote")).toHaveCount(0)
    expect(await thread.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await thread.screenshot({ path: `test-results/thread-${width}.png` })
    await thread.getByRole("button", { name: "Close", exact: true }).click()
    await expect(chat.locator(".chat-message-body").getByText("What is the vesting?", { exact: true })).toBeVisible()
    expect(await chat.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  })
}

test("Given selected item text, when Discuss sends then a quote returns to its exact source", async ({ page }) => {
  const item = await createItem(page)
  await item.locator(".detail-copy").evaluate(el => {
    const node = el.querySelector("p")!.firstChild!
    const range = document.createRange()
    range.setStart(node, 7)
    range.setEnd(node, 22)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
  })
  await page.getByRole("button", { name: "Discuss selection", exact: true }).click()
  const discussion = await send(page, "This part needs checking")
  await discussion.locator(".chat-message-item").getByRole("button", { name: /80k plus equity/ }).click()
  await expect(item.locator("mark")).toHaveText("80k plus equity")
})

test("Given a discussion draft and storage failure, when send fails then close/reopen retains draft and retry commits once", async ({ page }) => {
  const item = await createItem(page)
  await discussObject(page, item)
  const discussion = page.getByRole("dialog", { name: /^Discussion/ })
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    ;(window as any).__restoreDiscussionPut = () => { IDBObjectStore.prototype.put = original }
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if (this.name === "messages") throw new Error("Discussion storage failure")
      return original.apply(this, args)
    }
  })
  await discussion.getByRole("textbox", { name: "Message", exact: true }).fill("Keep discussion draft")
  await discussion.getByRole("button", { name: "Send message" }).click()
  await expect(discussion.getByRole("alert")).toContainText("Discussion storage failure")
  await discussion.getByRole("button", { name: "Close", exact: true }).click()
  await discussObject(page, item)
  await expect(discussion.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep discussion draft")
  await page.evaluate(() => (window as any).__restoreDiscussionPut())
  await send(page, "Keep discussion draft")
  await expect(discussion.locator(".chat-message-item")).toHaveCount(1)
})

test("Given item and discussion windows, when dragged resized and reopened then geometry and shared focus persist", async ({ page }) => {
  const item = await createItem(page)
  await discussObject(page, item)
  const discussion = page.getByRole("dialog", { name: /^Discussion/ })
  const before = await discussion.boundingBox()
  const titlebar = discussion.locator(".spatial-titlebar")
  await titlebar.focus()
  await page.keyboard.press("ArrowLeft")
  const moved = await discussion.boundingBox()
  expect(moved!.x).toBeLessThan(before!.x)
  const handle = discussion.getByRole("button", { name: /Resize/ })
  await handle.focus()
  await page.keyboard.press("ArrowLeft")
  const resized = await discussion.boundingBox()
  expect(resized!.width).toBeLessThan(moved!.width)
  await discussion.getByRole("button", { name: "Close", exact: true }).click()
  await discussObject(page, item)
  const restored = await discussion.boundingBox()
  expect(restored!.width).toBeCloseTo(resized!.width, 0)
  await page.setViewportSize({ width: 700, height: 600 })
  await expect.poll(async () => (await discussion.boundingBox())?.x).toBeGreaterThanOrEqual(0)
  await expect.poll(async () => {
    const clamped = await discussion.boundingBox()
    return clamped ? clamped.x + clamped.width : Infinity
  }).toBeLessThanOrEqual(700)
})

test("Given two items and a participant, when one discussion attaches both items and mentions the participant then one signed message references both", async ({ page }) => {
  const first = await createItem(page)
  await first.getByRole("button", { name: "Close detail", exact: true }).click()
  await page.getByRole("button", { name: "Add lead to Lead", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Add item" })
  await form.getByLabel("Company *").fill("Other Labs")
  await form.getByLabel("Role *").fill("Engineer")
  await form.getByRole("button", { name: "Create item" }).click()
  await expect(form).toBeHidden()
  await discussObject(page, page.getByRole("dialog", { name: "Item overview" }))
  const discussion = page.getByRole("dialog", { name: /^Discussion/ })
  await discussion.press("Alt+Backquote")
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Close detail", exact: true }).click()
  await page.getByRole("button", { name: /Open Anchor Labs/ }).click()
  await discussObject(page, page.getByRole("dialog", { name: "Item overview" }), "Discussion · Other Labs — Engineer")
  await discussion.getByRole("textbox", { name: "Message", exact: true }).fill("@")
  await discussion.getByRole("listbox", { name: "Participants" }).getByRole("option").first().click()
  await discussion.getByRole("textbox", { name: "Message", exact: true }).press("End")
  await discussion.getByRole("textbox", { name: "Message", exact: true }).pressSequentially("Compare these offers")
  await discussion.getByRole("button", { name: "Send message" }).click()
  await expect(discussion.locator(".chat-message-body")).toContainText("Compare these offers")
  await expect(discussion.getByText("Saving locally…", { exact: true })).toHaveCount(0)
  const context = await page.evaluate(async () => {
    const service = await import(/* @vite-ignore */ "/src/chat/service.ts")
    const state = await import(/* @vite-ignore */ "/src/state.ts")
    const chat = await service.loadChat(state.useTincanban().activeWorkspace.id)
    return chat.messages.at(-1)!.context
  })
  expect(context!.references).toHaveLength(2)
  expect(context!.mentions).toHaveLength(1)
  await discussion.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Close detail", exact: true }).click()
  await page.getByRole("button", { name: /Open Anchor Labs/ }).click()
  await discussObject(page, page.getByRole("dialog", { name: "Item overview" }))
  await expect(page.getByRole("dialog", { name: /^Discussion/ }).locator(".chat-message-item")).toHaveCount(1)
})

test("Given an open workspace chat and selected text in another window, when choosing Discuss in, then append its reference without replacing the draft or sending", async ({ page }) => {
  const item = await createItem(page)
  await page.getByRole("button", { name: "Workspace chat", exact: true }).click()
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Keep existing draft")
  const quote = await item.locator(".detail-copy").evaluate(el => {
    const text = el.querySelector("p")!.firstChild!
    const range = document.createRange()
    range.setStart(text, 7); range.setEnd(text, 22)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
    return range.toString()
  })
  await page.getByRole("button", { name: "Discuss selection", exact: true }).click()
  await page.getByRole("menuitem", { name: "Discuss in #Workspace chat", exact: true }).click()
  await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep existing draft")
  await expect(chat.locator(".draft-reference")).toContainText(quote)
  await expect(item).toBeVisible()
  await expect(chat.locator(".chat-message-item")).toHaveCount(0)
  await chat.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(chat.getByText("Saving locally…")).toHaveCount(0)
  await expect(chat.locator(".chat-message-item .reference-chips")).toContainText(quote)
})

test("Given a quoted passage changed after discussion, when its reference opens then original quote remains without false highlighting", async ({ page }) => {
  const item = await createItem(page)
  await item.locator(".detail-copy").evaluate(el => {
    const text = el.querySelector("p")!.firstChild!
    const range = document.createRange()
    range.setStart(text, 7); range.setEnd(text, 22)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
  })
  await page.getByRole("button", { name: "Discuss selection", exact: true }).click()
  await send(page, "Description needs review")
  await page.getByRole("dialog", { name: /^Discussion/ }).getByRole("button", { name: "Close", exact: true }).click()
  await item.getByRole("button", { name: "Edit", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Edit item" })
  await form.getByLabel("Description", { exact: true }).fill("Replacement description")
  await form.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(form).toBeHidden()
  await discussObject(page, item)
  const discussion = page.getByRole("dialog", { name: /^Discussion/ })
  await discussion.locator(".chat-message-item").getByRole("button", { name: /80k plus equity/ }).click()
  await expect(item.locator(".detail-copy")).toContainText("Replacement description")
  await expect(page.getByRole("status").filter({ hasText: "Source changed" })).toContainText("80k plus equity")
  await expect(item.locator("mark")).toHaveCount(0)
})

test("Given a pending discussion send, when its window closes and reopens then completion keeps one message", async ({ page }) => {
  const item = await createItem(page)
  await discussObject(page, item)
  const discussion = page.getByRole("dialog", { name: /^Discussion/ })
  await page.evaluate(() => {
    const original = SubtleCrypto.prototype.sign
    SubtleCrypto.prototype.sign = async function (...args: Parameters<SubtleCrypto["sign"]>) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      return original.apply(this, args)
    }
  })
  await discussion.getByRole("textbox", { name: "Message", exact: true }).fill("Pending window message")
  await discussion.getByRole("button", { name: "Send message" }).click()
  await expect(discussion.getByText("Saving locally…", { exact: true })).toBeVisible()
  await discussion.getByRole("button", { name: "Close", exact: true }).click()
  await discussObject(page, item)
  await expect(discussion.locator(".chat-message-body")).toHaveText("Pending window message")
  await expect(discussion.getByText("Saving locally…", { exact: true })).toHaveCount(0, { timeout: 10000 })
  await expect(discussion.locator(".chat-message-item")).toHaveCount(1)
  await expect(discussion.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("")
})


async function selectDescription(page: Page) {
  return page.getByRole("dialog", { name: "Item overview" }).locator(".detail-copy").evaluate(el => {
    const text = el.querySelector("p")!.firstChild!
    const range = document.createRange()
    range.setStart(text, 7); range.setEnd(text, 22)
    const selection = window.getSelection()!
    selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event("selectionchange"))
    return range.toString()
  })
}

test("Given two open reply conversations, when a selection chooses one at the viewport edge, then readable destinations fit and preserve its draft and reply context", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 })
  const item = await createItem(page)
  await page.getByRole("button", { name: "Workspace chat", exact: true }).focus()
  await page.keyboard.press("Enter")
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  for (const body of ["Offer negotiation", "Interview preparation"]) {
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill(body)
    await chat.getByRole("button", { name: "Send message", exact: true }).click()
    await expect(chat.getByText("Saving locally…", { exact: true })).toHaveCount(0)
    await expect(chat.locator(".chat-message-body").getByText(body, { exact: true })).toBeVisible()
  }
  const rootId = await chat.locator(".chat-message-item").filter({ hasText: "Offer negotiation" }).getAttribute("data-message-id")
  expect(rootId).toBeTruthy()
  await chat.locator(".chat-message-item").filter({ hasText: "Offer negotiation" }).getByRole("button", { name: "Reply to message", exact: true }).click()
  const thread = page.locator(`[data-window-id="conversation:${rootId}"]`)
  await thread.getByRole("textbox", { name: "Message", exact: true }).fill("Keep thread draft")
  await chat.focus()
  await chat.locator(".chat-message-item").filter({ hasText: "Interview preparation" }).getByRole("button", { name: "Reply to message", exact: true }).click()
  const quote = await selectDescription(page)
  await item.focus()
  await item.locator(".detail-copy").dispatchEvent("contextmenu", { clientX: 1270, clientY: 590 })
  await page.getByRole("menu", { name: "Discussion actions", exact: true }).getByRole("menuitem", { name: "Discuss", exact: true }).click()
  const menu = page.getByRole("menu", { name: "Choose chat", exact: true })
  await expect(menu.getByRole("menuitem", { name: "Discuss in #Replies · Offer negotiation", exact: true })).toBeVisible()
  await expect(menu.getByRole("menuitem", { name: "Discuss in #Replies · Interview preparation", exact: true })).toBeVisible()
  await expect.poll(async () => {
    const box = (await menu.boundingBox())!
    return box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 600
  }).toBe(true)
  await menu.getByRole("menuitem", { name: "Discuss in #Replies · Offer negotiation", exact: true }).click()
  await expect(thread.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Keep thread draft")
  await expect(thread.locator(".draft-reference")).toContainText(quote)
  await expect(item).toBeVisible()
  await expect(thread.locator(".chat-message-item")).toHaveCount(1)
  await thread.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(thread.getByText("Saving locally…", { exact: true })).toHaveCount(0)
  const saved = await page.evaluate(async () => {
    const service = await import("/src/chat/service.ts")
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    return (await service.loadChat(state.activeWorkspace.id)).messages.find(message => message.body === "Keep thread draft")!.context
  })
  expect(saved?.replyTo).toBe(rootId)
  expect(saved?.conversationRootId).toBe(rootId)
  expect(saved?.references[0]?.selection?.exact).toBe(quote)
  await selectDescription(page)
  await page.getByRole("button", { name: "Discuss selection", exact: true }).click()
  await page.getByRole("menuitem", { name: "Discuss in #Replies · Offer negotiation", exact: true }).click()
  await expect(thread.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("")
  await expect(thread.locator(".draft-reference")).toContainText(quote)
  await thread.getByRole("button", { name: "Close", exact: true }).click()
  await chat.focus()
  await chat.locator(".chat-message-item").filter({ hasText: "Offer negotiation" }).getByRole("button", { name: "1 reply", exact: true }).click()
  await expect(thread.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("")
  await expect(thread.locator(".draft-reference")).toContainText(quote)
})

test("Given a message still saving, when discussing a selection in that chat, then retain the chooser until saving finishes and attach without losing the reference", async ({ page }) => {
  const item = await createItem(page)
  await page.getByRole("button", { name: "Workspace chat", exact: true }).click()
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await page.evaluate(async () => {
    const { chatStore } = await import("/src/chat/store.ts")
    const append = chatStore.append.bind(chatStore)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    chatStore.append = async message => {
      if (message.body === "Saving first message") await gate
      return append(message)
    }
    ;(window as typeof window & { releaseChatAppend: () => void }).releaseChatAppend = () => { release(); chatStore.append = append }
  })
  try {
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Saving first message")
    await chat.getByRole("button", { name: "Send message", exact: true }).click()
    await expect(chat.getByText("Saving locally…", { exact: true })).toBeVisible()
    const quote = await selectDescription(page)
    await page.getByRole("button", { name: "Discuss selection", exact: true }).click()
    const destination = page.getByRole("menuitem", { name: "Discuss in #Workspace chat", exact: true })
    await expect(destination).toBeDisabled()
    await expect(page.getByRole("menu", { name: "Choose chat", exact: true }).getByRole("status")).toContainText("finish saving")
    await expect(item).toBeVisible()
    await page.evaluate(() => (window as typeof window & { releaseChatAppend: () => void }).releaseChatAppend())
    await expect(chat.getByText("Saving locally…", { exact: true })).toHaveCount(0)
    await expect(destination).toBeEnabled()
    await destination.click()
    await expect(chat.locator(".draft-reference")).toContainText(quote)
    await expect(chat.locator(".chat-message-item")).toHaveCount(1)
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Discuss after saving")
    await chat.getByRole("button", { name: "Send message", exact: true }).click()
    await expect(chat.getByText("Saving locally…", { exact: true })).toHaveCount(0)
    await expect(chat.locator(".chat-message-item")).toHaveCount(2)
    await expect(chat.locator(".chat-message-item").filter({ hasText: "Discuss after saving" }).locator(".reference-chips")).toContainText(quote)
  } finally {
    await page.evaluate(() => (window as typeof window & { releaseChatAppend?: () => void }).releaseChatAppend?.())
  }
})
