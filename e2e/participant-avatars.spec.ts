import { expect, test, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function openChat(page: Page) {
  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  return page.getByRole("dialog", { name: "Workspace chat", exact: true })
}

async function settings(page: Page) {
  if ((page.viewportSize()?.width ?? 1280) < 768) await page.getByRole("button", { name: "Menu", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  return page.getByRole("dialog", { name: "Settings", exact: true })
}

test("Given a long participant name, when the participant list narrows, then name and device count remain readable inside the row", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const profile = await settings(page)
  await profile.getByRole("textbox", { name: "Name", exact: true }).fill("ParticipantWithAnUnbrokenNameThatNeedsToWrap")
  await profile.getByRole("button", { name: "Save name", exact: true }).click()
  await expect(profile.getByRole("button", { name: "Save name", exact: true })).toBeEnabled()
  await profile.getByRole("tab", { name: "Connections", exact: true }).click()
  await profile.getByRole("button", { name: "Participants and devices", exact: true }).click()
  const row = page.getByRole("dialog", { name: "Device sync" }).locator(".mesh-member").first()
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(row.locator("small")).toContainText("known device")
    expect(await row.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return [...element.querySelectorAll<HTMLElement>("strong, small, .mesh-member-role")].every(text => {
        const textBounds = text.getBoundingClientRect()
        return text.scrollWidth <= text.clientWidth + 1 && textBounds.left >= bounds.left && textBounds.right <= bounds.right
      }) && element.scrollWidth <= element.clientWidth + 1
    })).toBe(true)
  }
})

for (const width of [1280, 390]) {
  test(`Given a ${width}px workspace, when an author renames and reloads, then their chat and participant avatar stays stable`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    let chat = await openChat(page)
    await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Recognize this author")
    await chat.getByRole("button", { name: "Send message" }).click()
    await expect(chat.getByText("Saving locally…", { exact: true })).toHaveCount(0)
    const avatar = chat.locator(".chat-message-meta .participant-avatar")
    await expect(avatar).toBeVisible()
    await expect(avatar).toHaveAttribute("aria-hidden", "true")
    const drawing = await avatar.innerHTML()
    await chat.getByRole("button", { name: "Close", exact: true }).click()
    const profile = await settings(page)
    await profile.getByRole("tab", { name: "Identity" }).click()
    await profile.getByRole("textbox", { name: "Name", exact: true }).fill("Avatar author")
    await profile.getByRole("button", { name: "Save name", exact: true }).click()
    await expect(profile.getByRole("button", { name: "Save name", exact: true })).toBeEnabled()
    await expect(profile.getByRole("textbox", { name: "Name", exact: true })).toHaveValue("Avatar author")
    await profile.getByRole("tab", { name: "Connections", exact: true }).click()
    await profile.getByRole("button", { name: "Participants and devices", exact: true }).click()
    const participants = page.getByRole("dialog", { name: "Device sync" })
    await expect(participants.locator(".participant-avatar").first()).toBeVisible()
    expect(await participants.locator(".participant-avatar").first().innerHTML()).toBe(drawing)
    await participants.getByRole("button", { name: "Close", exact: true }).click()
    await page.reload()
    chat = await openChat(page)
    await expect(chat.locator(".chat-message-author")).toHaveText("Avatar author")
    expect(await chat.locator(".chat-message-meta .participant-avatar").innerHTML()).toBe(drawing)
    expect(await chat.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  })
}

test("Given slow signing, when a message is pending then fails, then its avatar stays stable and retry preserves attribution", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const chat = await openChat(page)
  await page.evaluate(() => {
    const original = SubtleCrypto.prototype.sign
    ;(window as any).__restoreAvatarSign = () => { SubtleCrypto.prototype.sign = original }
    SubtleCrypto.prototype.sign = async () => {
      await new Promise(resolve => setTimeout(resolve, 1500))
      throw new Error("Avatar signing failure")
    }
  })
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Retain my author")
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.getByText("Saving locally…", { exact: true })).toBeVisible()
  await expect(chat.locator(".chat-message-meta .participant-avatar")).toBeVisible()
  const drawing = await chat.locator(".chat-message-meta .participant-avatar").innerHTML()
  await expect(chat.getByRole("alert")).toContainText("Avatar signing failure")
  await expect(chat.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Retain my author")
  await page.evaluate(() => (window as any).__restoreAvatarSign())
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.getByText("Saving locally…", { exact: true })).toHaveCount(0)
  await expect(chat.locator(".chat-message-body")).toHaveText("Retain my author")
  expect(await chat.locator(".chat-message-meta .participant-avatar").innerHTML()).toBe(drawing)
})

test("Given two signed participants share a name, when one profile disappears offline, then names stay distinct and their retained avatar stays stable", async ({ page }) => {
  const browserErrors: string[] = []
  page.on("pageerror", error => browserErrors.push(error.message))
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  let chat = await openChat(page)
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Owner with shared name")
  await chat.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(chat.getByText("Owner with shared name", { exact: true })).toBeVisible()
  const peer = await page.evaluate(async () => {
    const identityPath = "/src/domain/identity.ts"
    const meshIdentityPath = "/vendor/meta-mesh/packages/mesh-identity/src/index.ts"
    const proofPath = "/src/domain/proofs.ts"
    const recordsPath = "/src/chat/records.ts"
    const servicePath = "/src/chat/service.ts"
    const statePath = "/src/state.ts"
    const { bootstrapIdentity } = await import(/* @vite-ignore */ identityPath)
    const { BrowserIdentityStore } = await import(/* @vite-ignore */ meshIdentityPath)
    const { createWorkspaceGrant } = await import(/* @vite-ignore */ proofPath)
    const { createChatRecord } = await import(/* @vite-ignore */ recordsPath)
    const service = await import(/* @vite-ignore */ servicePath)
    const state = await import(/* @vite-ignore */ statePath)
    const owner = await bootstrapIdentity()
    const id = state.useTincanban().activeWorkspace.id
    const scope = await service.getChatScope(id)
    const participant = await new BrowserIdentityStore({ storageKey: "test-avatar-peer", signatureDomain: "MATCH/1" }).bootstrap(owner.identity.displayName)
    const grant = await createWorkspaceGrant(owner, id, participant.identity.personId, "editor")
    const authority = { publicKey: owner.identity.publicKey, certificates: [owner.certificate], grant }
    const profile = await createChatRecord(participant, [participant.certificate], authority, scope, "chat-profile", owner.identity.displayName, 1)
    const message = await createChatRecord(participant, [participant.certificate], authority, scope, "chat-message", "Peer with shared name")
    await service.receiveChat(id, { version: 1, profiles: [profile], messages: [message], typing: [] }, true)
    return { scope, personId: participant.identity.personId }
  })
  const peerRow = chat.locator(".chat-message-item").filter({ hasText: "Peer with shared name" })
  await expect(peerRow).toBeVisible()
  const authors = await chat.locator(".chat-message-author").allTextContents()
  expect(authors).toHaveLength(2)
  expect(authors[0]).not.toBe(authors[1])
  expect(authors.every(name => name.includes(" · "))).toBe(true)
  const drawing = await peerRow.locator(".participant-avatar").innerHTML()
  await page.evaluate(async ({ scope, personId }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("tincanban-chat-v1")
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const transaction = db.transaction("profiles", "readwrite")
        transaction.objectStore("profiles").delete([scope, personId])
        transaction.oncomplete = () => { db.close(); resolve() }
        transaction.onerror = () => { db.close(); reject(transaction.error) }
      }
    })
  }, peer)
  await page.reload()
  chat = await openChat(page)
  const retainedPeer = chat.locator(".chat-message-item").filter({ hasText: "Peer with shared name" })
  await expect(retainedPeer.locator(".chat-message-author")).toHaveText(`Participant · ${peer.personId.slice(0, 6)}`)
  expect(await retainedPeer.locator(".participant-avatar").innerHTML()).toBe(drawing)
  expect(browserErrors).toEqual([])
})
