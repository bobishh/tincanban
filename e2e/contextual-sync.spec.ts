import { discussObject } from "./support/discussions"
import { expect, test, type Page } from "./support/coverage"

async function openChat(page: Page) {
  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  return page.getByRole("dialog", { name: "Workspace chat", exact: true })
}
async function createSource(page: Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Context sync")
  await create.getByRole("radio", { name: "Blank board" }).check()
  await create.getByRole("button", { name: "Create", exact: true }).click()
  await expect(create).toBeHidden()
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Shared context source")
  await form.getByRole("button", { name: "Save item", exact: true }).click()
  await expect(form).toBeHidden()
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const service = await import(/* @vite-ignore */ "/src/chat/service.ts")
    const state = (await import(/* @vite-ignore */ "/src/state.ts")).useTincanban()
    return service.loadChat(state.activeWorkspace.id)
  })
}

test("Given independent paired peers, when signed object discussions sync, then context and avatars converge and unsupported or tampered records remain bounded", async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000)
  const guestContext = await browser.newContext({ baseURL })
  const guest = await guestContext.newPage()
  try {
    await createSource(page)
    const ownerId = await page.evaluate(async () => (await import(/* @vite-ignore */ "/src/domain/identity.ts")).bootstrapIdentity().then(profile => profile.identity.personId))
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostSync = page.getByRole("dialog", { name: "Device sync" })
    await hostSync.getByRole("button", { name: "Add someone" }).click()
    await hostSync.getByRole("button", { name: "Generate link" }).click()
    await guest.goto(await hostSync.getByLabel("Pairing link").inputValue())
    const guestSync = guest.getByRole("dialog", { name: "Device sync" })
    await guestSync.getByRole("button", { name: "Accept and join" }).click()
    await page.getByLabel("Participant role").selectOption("editor")
    await page.getByRole("button", { name: "Approve access" }).click()
    await expect(guestSync.getByText("Connected to Context sync", { exact: true })).toBeVisible({ timeout: 30_000 })
    await guestSync.getByRole("button", { name: "Close", exact: true }).first().click()
    await hostSync.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(guest.getByRole("button", { name: "Open Shared context source", exact: true })).toBeVisible({ timeout: 15_000 })
    const hostChat = await openChat(page)
    const guestChat = await openChat(guest)

    const committed = await test.step("When peer capability is negotiated, contextual metadata crosses the real connection", async () => {
      let message: any
      await expect.poll(async () => {
        try {
          message = await guest.evaluate(async mention => {
            const service = await import(/* @vite-ignore */ "/src/chat/service.ts")
            const state = (await import(/* @vite-ignore */ "/src/state.ts")).useTincanban()
            const model = await import(/* @vite-ignore */ "/src/domain/model.ts")
            const item = Object.values(state.getActiveDoc().entities).find((entity: any) => model.isItem(entity) && entity.title === "Shared context source") as any
            const scope = await service.getChatScope(state.activeWorkspace.id)
            return service.sendChatMessage(state.activeWorkspace.id, "Context crosses independent peers", {
              references: [{ workspaceScope: scope, boardId: state.activeBoard.value.id, itemId: item.id }], mentions: [mention],
            })
          }, ownerId)
          return "sent"
        } catch (error) { return String(error) }
      }, { timeout: 20_000 }).toBe("sent")
      await expect(hostChat.getByText("Context crosses independent peers", { exact: true })).toBeVisible({ timeout: 15_000 })
      const received = (await snapshot(page)).messages.find((value: any) => value.id === message.id)
      expect(received?.context).toEqual(message.context)
      expect(received?.record).toEqual(message.record)
      expect(received?.context?.mentions).toEqual([ownerId])
      expect((await snapshot(page)).messages.filter((value: any) => value.id === message.id)).toHaveLength(1)
      const ownerAvatar = await hostChat.locator(`[data-message-id="${message.id}"] .participant-avatar`).evaluate(element => element.outerHTML)
      const guestAvatar = await guestChat.locator(`[data-message-id="${message.id}"] .participant-avatar`).evaluate(element => element.outerHTML)
      expect(ownerAvatar).toBe(guestAvatar)
      return message
    })

    await test.step("Then one synced record appears in the source discussion and replies converge", async () => {
      await hostChat.getByRole("button", { name: "Close", exact: true }).click()
      await page.getByRole("button", { name: "Open Shared context source", exact: true }).click()
      const item = page.getByRole("dialog", { name: "Item overview", exact: true })
      await discussObject(page, item)
      const discussion = page.getByRole("dialog", { name: "Discussion · Shared context source", exact: true })
      await expect(discussion.getByText("Context crosses independent peers", { exact: true })).toBeVisible()
      await discussion.locator(`[data-message-id="${committed.id}"]`).getByRole("button", { name: "Reply to message" }).click()
      const thread = page.getByRole("dialog", { name: "Discussion · replies", exact: true })
      await thread.getByRole("textbox", { name: "Message", exact: true }).fill("Owner reply stays in same root")
      await thread.getByRole("button", { name: "Send message", exact: true }).click()
      await expect(guestChat.getByRole("button", { name: "1 reply", exact: true })).toContainText("1 reply", { timeout: 15_000 })
      await guestChat.getByRole("button", { name: "1 reply", exact: true }).click()
      await expect(guest.getByRole("dialog", { name: "Discussion · replies", exact: true }).getByText("Owner reply stays in same root", { exact: true })).toBeVisible()
      await guest.getByRole("dialog", { name: "Discussion · replies", exact: true }).getByRole("button", { name: "Close", exact: true }).click()
      const reply = (await snapshot(guest)).messages.find((value: any) => value.body === "Owner reply stays in same root")
      expect(reply?.context?.replyTo).toBe(committed.id)
      expect(reply?.context?.conversationRootId).toBe(committed.id)
      await thread.getByRole("button", { name: "Close", exact: true }).click()
      await discussion.getByRole("button", { name: "Close", exact: true }).click()
      await item.getByRole("button", { name: "Dismiss", exact: true }).click()
      await openChat(page)
    })

    await test.step("Then invalid signature metadata never enters accepted views", async () => {
      const before = (await snapshot(page)).messages.length
      const forged = structuredClone(committed.record)
      forged.signed.payload.context.references[0].itemId = "tampered-item"
      await page.evaluate(async record => {
        const service = await import(/* @vite-ignore */ "/src/chat/service.ts")
        const state = (await import(/* @vite-ignore */ "/src/state.ts")).useTincanban()
        await service.receiveChat(state.activeWorkspace.id, { version: 1, capabilities: ["contextual-v2"], messages: [record], profiles: [] }, false)
      }, forged)
      expect((await snapshot(page)).messages).toHaveLength(before)
      expect((await snapshot(page)).messages.find((value: any) => value.id === committed.id)?.context).toEqual(committed.context)
    })

    await test.step("Then signed out-of-order reply retains unavailable quote and resolves when root arrives", async () => {
      const records = await guest.evaluate(async authorityRecord => {
        const identity = await import(/* @vite-ignore */ "/src/domain/identity.ts")
        const signing = await import(/* @vite-ignore */ "/src/chat/signing.ts")
        const { resolveSigningContext } = await import(/* @vite-ignore */ "/src/domain/signingContext.ts")
        const profile = await identity.bootstrapIdentity()
        const original = authorityRecord.signed.payload
        const authorityRevision = JSON.stringify(authorityRecord.authority)
        const contextFor = () => resolveSigningContext({ profile, certificates: authorityRecord.certificates,
          purpose: "chat-message", binding: { workspaceId: original.workspaceId }, authorityRevision,
          current: async () => ({ personId: profile.identity.personId, deviceId: profile.device.deviceId, authorityRevision }) })
        const root = await signing.createChatRecord(profile, authorityRecord.authority, original.workspaceId,
          "chat-message", "Later retained root", 0, { references: original.context.references, mentions: [] }, await contextFor())
        const reply = await signing.createChatRecord(profile, authorityRecord.authority, original.workspaceId,
          "chat-message", "Reply arrives first", 0,
          { references: [], mentions: [], replyTo: root.signed.payload.id, conversationRootId: root.signed.payload.id }, await contextFor())
        return { root, reply }
      }, committed.record)
      for (const record of [records.reply, records.root]) {
        await page.evaluate(async signedRecord => {
          const service = await import(/* @vite-ignore */ "/src/chat/service.ts")
          const state = (await import(/* @vite-ignore */ "/src/state.ts")).useTincanban()
          await service.receiveChat(state.activeWorkspace.id, { version: 1, capabilities: ["contextual-v2"], messages: [signedRecord], profiles: [] }, false)
        }, record)
        const reply = page.locator(`[data-message-id="${records.reply.signed.payload.id}"]`).filter({ visible: true })
        if (record === records.root) await hostChat.locator(`[data-message-id="${records.root.signed.payload.id}"]`).getByRole("button", { name: "1 reply", exact: true }).click()
        await expect(reply).toBeVisible()
        if (record === records.reply) await expect(reply.locator(".reply-quote")).toHaveText("Message unavailable")
        else await expect(reply.locator(".reply-quote")).toHaveCount(0)
      }
      await expect(guestChat.locator(`[data-message-id="${records.root.signed.payload.id}"]`).getByRole("button", { name: "1 reply", exact: true })).toBeVisible({ timeout: 15_000 })
      await guestChat.locator(`[data-message-id="${records.root.signed.payload.id}"]`).getByRole("button", { name: "1 reply", exact: true }).click()
      await expect(guest.getByRole("dialog", { name: "Discussion · replies", exact: true }).getByText("Reply arrives first", { exact: true })).toBeVisible()
    })

    await test.step("Then legacy boundary requests upgrade without changing contextual signatures", async () => {
      const result = await page.evaluate(async () => {
        const service = await import(/* @vite-ignore */ "/src/chat/service.ts")
        const state = (await import(/* @vite-ignore */ "/src/state.ts")).useTincanban()
        const id = state.activeWorkspace.id
        await service.receiveChat(id, { version: 1, messages: [], profiles: [] }, false, "legacy-test-device")
        const saved = await service.sendChatMessage(id, "Must not downgrade", { references: [], mentions: [state.getCurrentProfile().identity.personId] })
        const known = new Set<string>()
        const boundary = await service.exportChat(id, known, "legacy-test-device")
        await service.receiveChat(id, { version: 1, capabilities: ["contextual-v2"], messages: [], profiles: [] }, false, "legacy-test-device")
        const upgraded = await service.exportChat(id, known, "legacy-test-device")
        return { saved, boundary, upgraded }
      })
      expect(result.boundary.upgradeRequired).toBe(true)
      expect(result.boundary.messages.every((record: any) => record.signed.payload.version === 1)).toBe(true)
      expect(result.boundary.messages).not.toContainEqual(result.saved.record)
      expect(result.upgraded.messages).toContainEqual(committed.record)
      expect(result.upgraded.messages).toContainEqual(result.saved.record)
      await expect(hostChat.getByText("Must not downgrade", { exact: true })).toBeVisible()
    })
  } finally { await guestContext.close() }
})
