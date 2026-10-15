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

test("Given paired workspaces, when matching names and messages sync, then both peers show stable suffixes and offline messages recover", async ({ page, browser }) => {
  test.setTimeout(90_000)
  const context = await browser.newContext()
  const guest = await context.newPage()
  type Diagnostic = { event: string; entity_id: string; trace_id: string; device_id: string; session_id: string; attrs: { phase?: string } }
  const hostEvents: Diagnostic[] = [], guestEvents: Diagnostic[] = []
  for (const [peer, events] of [[page, hostEvents], [guest, guestEvents]] as const) {
    await peer.route("https://telemetry.invalid/events", async route => {
      const batch = route.request().postDataJSON() as { events: Diagnostic[] }
      events.push(...batch.events)
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ accepted: batch.events.length }) })
    })
  }
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    const settings = await profileSettings(page)
    await settings.getByRole("textbox", { name: "Name", exact: true }).fill("Тревожная мимоза")
    await settings.getByRole("button", { name: "Save profile", exact: true }).click()
    await expect(settings.getByText("Profile saved.", { exact: true })).toBeVisible()
    await expect(settings.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Тревожная мимоза")
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostSync = page.getByRole("dialog", { name: "Device sync" })
    await hostSync.getByRole("button", { name: "Add someone" }).click()
    await hostSync.getByRole("button", { name: "Generate link" }).click()
    const inviteUrl = await hostSync.getByLabel("Pairing link").inputValue()
    await guest.goto("/")
    const privateChat = await openChat(guest)
    await privateChat.getByRole("textbox", { name: "Message", exact: true }).fill("Private local chat")
    await privateChat.getByRole("button", { name: "Send message" }).click()
    await expect(privateChat.getByText("Private local chat", { exact: true })).toBeVisible()
    await expect(privateChat.getByText("Saving locally…", { exact: true })).toHaveCount(0)
    await guest.goto(inviteUrl)
    const guestSync = guest.getByRole("dialog", { name: "Device sync" })
    await guestSync.getByRole("button", { name: "Accept and join" }).click()
    await page.getByLabel("Participant role").selectOption("editor")
    await page.getByRole("button", { name: "Approve access" }).click()
    await expect(guestSync.getByText("Connected to Job search")).toBeVisible({ timeout: 30_000 })
    await guestSync.getByRole("button", { name: "Close", exact: true }).first().click()
    await hostSync.getByRole("button", { name: "Close", exact: true }).first().click()
    const guestSettings = await profileSettings(guest)
    await guestSettings.getByRole("textbox", { name: "Name", exact: true }).fill("Тревожная мимоза")
    await guestSettings.getByRole("button", { name: "Save profile", exact: true }).click()
    await expect(guestSettings.getByText("Profile saved.", { exact: true })).toBeVisible()
    await expect(guestSettings.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Тревожная мимоза")
    await guestSettings.getByRole("button", { name: "Dismiss", exact: true }).click()
    const guestChat = await openChat(guest)
    await expect(guestChat.getByText("Private local chat", { exact: true })).toHaveCount(0)
    await test.step("Typing presence updates without publishing a message", async () => {
      await expect(page.getByLabel("Workspace presence")).toContainText("2 devices")
      await expect(page.getByLabel("Workspace presence")).not.toContainText("editor")
      const typingChat = await openChat(page)
      await guestChat.getByRole("textbox", { name: "Message", exact: true }).fill("Unsaved draft")
      await expect(typingChat.getByRole("status", { name: "Typing presence" })).toContainText("is typing", { timeout: 15_000 })
      await expect(typingChat.locator(".chat-message-item")).toHaveCount(0)
      await guestChat.getByRole("textbox", { name: "Message", exact: true }).fill("")
      await expect(typingChat.getByRole("status", { name: "Typing presence" })).toHaveCount(0, { timeout: 15_000 })
      await typingChat.getByRole("button", { name: "Close", exact: true }).click()
    })
    await guestChat.getByRole("textbox", { name: "Message", exact: true }).fill("Hello from guest")
    const sentAt = Date.now()
    await guestChat.getByRole("button", { name: "Send message" }).click()
    await expect(guestChat.locator(".chat-message-author")).toContainText("Тревожная мимоза · ")
    await expect(page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true })).toContainText("1", { timeout: 15_000 })
    const hostChat = await openChat(page)
    await expect(hostChat.getByText("Private local chat", { exact: true })).toHaveCount(0)
    await expect(hostChat.getByText("Hello from guest", { exact: true })).toBeVisible({ timeout: 15_000 })
    await test.step("Given a real P2P message, when both devices report persistence, then full entity and trace IDs correlate", async () => {
      await expect.poll(() => guestEvents.some(event => event.event === "chat.submit" && hostEvents.some(remote => remote.entity_id === event.entity_id && remote.event === "chat.persisted" && remote.attrs.phase === "remote")), { timeout: 15000 }).toBe(true)
      const submitted = guestEvents.find(event => event.event === "chat.submit" && hostEvents.some(remote => remote.entity_id === event.entity_id && remote.event === "chat.persisted" && remote.attrs.phase === "remote"))!
      await expect.poll(() => hostEvents.some(event => event.event === "chat.persisted" && event.entity_id === submitted.entity_id && event.attrs.phase === "remote"), { timeout: 15000 }).toBe(true)
      const received = hostEvents.find(event => event.event === "chat.persisted" && event.entity_id === submitted.entity_id)!
      expect(received.trace_id).toBe(submitted.trace_id)
      expect(received.trace_id).toMatch(/^[0-9a-f]{32}$/)
      expect(received.device_id).not.toBe(submitted.device_id)
      expect(received.session_id).not.toBe(submitted.session_id)
      expect(JSON.stringify([...hostEvents, ...guestEvents])).not.toContain("Hello from guest")
    })
    console.info(`Chat delivery: sender submit to receiver visible = ${Date.now() - sentAt}ms`)
    await expect(hostChat.locator(".chat-message-author")).toHaveText(await guestChat.locator(".chat-message-author").textContent() ?? "")
    await hostChat.getByRole("button", { name: "Close", exact: true }).click()
    await page.bringToFront()
    await guest.evaluate(async () => {
      const path = "/src/chat/service.ts"
      const statePath = "/src/state.ts"
      const service = await import(/* @vite-ignore */ path)
      const state = await import(/* @vite-ignore */ statePath)
      await service.sendChatMessage(state.useTincanban().activeWorkspace.id, "Background message")
    })
    await expect(page.locator(".chat-toast")).toContainText("Background message", { timeout: 15_000 })
    await page.getByRole("button", { name: "Dismiss chat notification" }).click()
    const replay = await guest.evaluate(async () => {
      const path = "/src/chat/service.ts"
      const statePath = "/src/state.ts"
      const state = await import(/* @vite-ignore */ statePath)
      return (await import(/* @vite-ignore */ path)).exportChat(state.useTincanban().activeWorkspace.id)
    })
    await page.evaluate(async wire => {
      const path = "/src/chat/service.ts"
      const statePath = "/src/state.ts"
      const state = await import(/* @vite-ignore */ statePath)
      await (await import(/* @vite-ignore */ path)).receiveChat(state.useTincanban().activeWorkspace.id, wire, false)
    }, replay)
    await expect(page.locator(".chat-toast")).toHaveCount(0)
    await openChat(page)
    await context.setOffline(true)
    await guestChat.getByRole("textbox", { name: "Message", exact: true }).fill("Offline chat survives")
    await guestChat.getByRole("button", { name: "Send message" }).click()
    await expect(guestChat.getByText("Offline chat survives", { exact: true })).toBeVisible()
    await context.setOffline(false)
    await expect(hostChat.getByText("Offline chat survives", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(hostChat.locator(".chat-message-body")).toHaveCount(3)
    await guestChat.getByRole("button", { name: "Close", exact: true }).click()
    await guest.getByRole("button", { name: "Open workspaces", exact: true }).click()
    await guest.getByRole("button", { name: /^Untitled/ }).click()
    const restoredPrivate = await openChat(guest)
    await expect(restoredPrivate.getByText("Private local chat", { exact: true })).toBeVisible()
    await expect(restoredPrivate.getByText("Hello from guest", { exact: true })).toHaveCount(0)
  } finally { await context.close() }
})
