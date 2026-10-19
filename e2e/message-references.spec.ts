import { expect, test, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

let browserErrors: string[] = []
test.beforeEach(({ page }) => {
  browserErrors = []
  page.on("pageerror", error => browserErrors.push(error.message))
})
test.afterEach(() => { expect(browserErrors).toEqual([]) })

async function messageLink(page: Page) {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Linked local message")
  await chat.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(chat.getByText("Saving locally…", { exact: true })).toHaveCount(0)
  return chat
}

async function copiedLink(page: Page) {
  const chat = await messageLink(page)
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (text: string) => { sessionStorage.setItem("test-message-link", text) },
    } })
  })
  await chat.getByRole("button", { name: "Copy link", exact: true }).click()
  await expect(chat.getByRole("button", { name: "Copied ✓", exact: true })).toBeVisible()
  const url = await page.evaluate(() => sessionStorage.getItem("test-message-link"))
  expect(url).toBeTruthy()
  return url!
}

function changeReference(url: string, update: Record<string, unknown>) {
  const link = new URL(url)
  const reference = JSON.parse(decodeURIComponent(link.hash.slice("#message=".length)))
  link.hash = `message=${encodeURIComponent(JSON.stringify({ ...reference, ...update }))}`
  return link.toString()
}

test("Given a committed local message, when its copied link reloads, then chat reveals and highlights that exact message", async ({ page }) => {
  const url = await copiedLink(page)
  expect(url).not.toContain("Linked local message")
  await page.goto(url)
  await page.reload()
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await expect(chat).toBeVisible()
  await expect(chat.locator(".is-linked-message")).toContainText("Linked local message")
  await expect(chat.getByText("Linked local message", { exact: true })).toHaveCount(1)
})

test("Given a linked message, when closing chat, then URL clears and the same link can open it again", async ({ page }) => {
  const url = await copiedLink(page)
  const link = new URL(url)
  link.searchParams.set("view", "board")
  await page.goto(link.toString())
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await expect(chat.locator(".is-linked-message")).toContainText("Linked local message")
  await chat.getByRole("button", { name: "Close", exact: true }).click()
  link.hash = ""
  await expect(page).toHaveURL(link.toString())
  await expect(chat).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(chat).toHaveCount(0)
  await page.goto(url)
  await expect(chat.locator(".is-linked-message")).toContainText("Linked local message")
})

test("Given an unavailable linked message, when closing its error chat, then URL and retry feedback clear", async ({ page }) => {
  const url = await copiedLink(page)
  const unavailableUrl = changeReference(url, { messageId: "missing-device:missing-message" })
  await page.goto(unavailableUrl)
  await expect(page.getByText("Message unavailable", { exact: true }).first()).toBeVisible()
  await page.getByRole("dialog", { name: "Workspace chat", exact: true }).getByRole("button", { name: "Close", exact: true }).click()
  const boardAddress = new URL(unavailableUrl)
  boardAddress.hash = ""
  await expect(page).toHaveURL(boardAddress.toString())
  await expect(page.getByRole("button", { name: "Retry message link" })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
  await expect(page.getByRole("dialog", { name: "Workspace chat", exact: true })).toHaveCount(0)
})

test("Given denied clipboard access, when copying a message link, then a selectable local URL and honest feedback remain", async ({ page }) => {
  const chat = await messageLink(page)
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { throw new DOMException("Denied", "NotAllowedError") },
    } })
  })
  await chat.getByRole("button", { name: "Copy link", exact: true }).click()
  await expect(chat.getByText("Clipboard unavailable. Select and copy this link.", { exact: true })).toBeVisible()
  const input = chat.getByRole("textbox", { name: "Message link", exact: true })
  await expect(input).toHaveValue(/#message=/)
  await expect(chat.getByRole("button", { name: "Copied ✓", exact: true })).toHaveCount(0)
  await expect(chat.getByText("Workspace must already be available on the receiving device.", { exact: true })).toBeVisible()
})

test("Given an unknown workspace reference, when opening its link, then workspace unavailable appears without highlighting an unrelated target", async ({ page }) => {
  const url = await copiedLink(page)
  await page.goto(changeReference(url, { workspaceScope: "unknown-workspace-scope" }))
  await expect(page.getByText("Workspace unavailable", { exact: true })).toBeVisible()
  await expect(page.locator(".is-linked-message")).toHaveCount(0)
})

test("Given a retained workspace with an absent target, when opening its link, then message unavailable appears after loading", async ({ page }) => {
  const url = await copiedLink(page)
  await page.goto(changeReference(url, { messageId: "missing-device:missing-message" }))
  await expect(page.getByText("Message unavailable", { exact: true })).toBeVisible()
})

test("Given a malformed reference, when opening its link, then invalid-link feedback appears", async ({ page }) => {
  await page.goto("/#message=%7Bbroken")
  await expect(page.getByText("Invalid message link", { exact: true })).toBeVisible()
})

test("Given signing remains pending, when its optimistic message appears, then copy stays unavailable until commit", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await page.evaluate(() => {
    const original = SubtleCrypto.prototype.sign
    SubtleCrypto.prototype.sign = async function (...args: Parameters<SubtleCrypto["sign"]>) {
      await new Promise(resolve => setTimeout(resolve, 1800))
      return original.apply(this, args)
    }
  })
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Pending link")
  await chat.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(chat.getByText("Saving locally…", { exact: true })).toBeVisible()
  await expect(chat.getByRole("button", { name: "Copy link", exact: true })).toBeDisabled()
  await expect(chat.getByText("Saving locally…", { exact: true })).toHaveCount(0)
  await expect(chat.getByRole("button", { name: "Copy link", exact: true })).toBeEnabled()
})


test("Given a target older than 100 messages, when its link opens, then that retained message becomes visible", async ({ page }) => {
  const url = await copiedLink(page)
  await page.evaluate(async () => {
    const servicePath = "/src/chat/service.ts"
    const statePath = "/src/state.ts"
    const service = await import(/* @vite-ignore */ servicePath)
    const state = await import(/* @vite-ignore */ statePath)
    const id = state.useTincanban().activeWorkspace.id
    for (let index = 0; index < 105; index++) await service.sendChatMessage(id, `Later message ${index}`)
  })
  await expect(page.getByText("Linked local message", { exact: true })).toHaveCount(0)
  await page.goto(url)
  await expect(page.locator(".is-linked-message")).toContainText("Linked local message")
  await expect(page.getByText("Linked local message", { exact: true })).toBeVisible()
})

test("Given chat loading remains pending, when opening a link, then loading precedes retained-message resolution", async ({ page }) => {
  const url = await copiedLink(page)
  await page.evaluate(async () => {
    const storePath = "/src/chat/store.ts"
    const { chatStore } = await import(/* @vite-ignore */ storePath)
    const original = chatStore.load.bind(chatStore)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    ;(window as any).__releaseReferenceLoad = () => { chatStore.load = original; release() }
    chatStore.load = async (...args: Parameters<typeof original>) => { await pending; return original(...args) }
  })
  await page.goto(url)
  await expect(page.getByText("Loading messages…", { exact: true }).first()).toBeVisible()
  await expect(page.getByText("Message unavailable", { exact: true })).toHaveCount(0)
  await page.evaluate(() => (window as any).__releaseReferenceLoad())
  await expect(page.locator(".is-linked-message")).toContainText("Linked local message")
})

test("Given a copied link before local workspace rekeying, when its preserved scope opens afterward, then the same message resolves", async ({ page }) => {
  const url = await copiedLink(page)
  await page.evaluate(async () => {
    const storagePath = "/src/storage.ts"
    const statePath = "/src/state.ts"
    const { defaultStorage } = await import(/* @vite-ignore */ storagePath)
    const state = await import(/* @vite-ignore */ statePath)
    const tincanban = state.useTincanban()
    const id = tincanban.activeWorkspace.id
    const source = tincanban.getActiveDoc()
    if (!source) throw new Error("Active workspace unavailable during rekey fixture")
    const moved = await tincanban.importWorkspaceAsNew(source)
    if (moved.id === id) throw new Error("Workspace rekey fixture did not change the document ID")
    await tincanban.renameWorkspaceAsync(moved.id, "Rekeyed workspace")
    const root = await defaultStorage.loadPersonalRoot()
    if (!root) throw new Error("Personal root unavailable during rekey fixture")
    delete root.workspaces[id]
    await defaultStorage.savePersonalRoot(root)
  })
  await page.goto(url)
  await page.reload()
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Rekeyed workspace")
  // The board-derived chat scope remains stable across document-ID rekeying.
  await expect(page.locator(".is-linked-message")).toContainText("Linked local message")
})
