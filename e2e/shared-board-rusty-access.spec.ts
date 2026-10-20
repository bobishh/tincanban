import { expect, test, type Page } from "@playwright/test"
import { startRustyService } from "./support/rustyService"

async function join(owner: Page, guest: Page, role: "editor" | "visitor", storageConfigured = true) {
  const host = owner.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Generate link" }).click()
  await guest.goto(await host.getByLabel("Pairing link").inputValue())
  const joining = guest.getByRole("dialog", { name: "Device sync" })
  await joining.getByRole("button", { name: "Accept and join" }).click()
  await expect(host.getByLabel("Participant role")).toBeVisible({ timeout: 30_000 })
  await host.getByLabel("Participant role").selectOption(role)
  await host.getByRole("button", { name: "Approve access" }).click()
  await expect(joining.getByText(/Connected to/)).toBeVisible({ timeout: 40_000 })
  await joining.getByRole("button", { name: "Close", exact: true }).click()
  await host.getByRole("button", { name: "Close", exact: true }).click()
  await guest.getByRole("button", { name: "Sync", exact: true }).click()
  const storage = guest.getByRole("region", { name: "Rusty", exact: true })
  if (!storageConfigured) {
    await expect(storage.locator(".rusty-connections")).toHaveCount(0)
    return
  }
  await expect(storage.getByText(role === "editor" ? "Board access · read and write" : "Board access · read only", { exact: true }))
    .toBeVisible({ timeout: 30_000 })
  await expect(storage.getByRole("button", { name: "Add Rusty", exact: true })).toHaveCount(0)
  await expect(storage.getByRole("heading", { name: "Profile delivery", exact: true })).toHaveCount(0)
}

test("Given three distinct identities and owner-configured Rusty, when owner closes and peer routes are disabled, then editor publishes and visitor reads via Rusty only", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(180_000)
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 25_000 })
  await page.evaluate(async () => (await import("/src/state.ts")).useTincanban().createWorkspaceAsync("Shared Rusty acceptance", "blank"))
  const owner = await page.evaluate(async () => {
    const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
    return { identity: profile.identity, allowedControllerDeviceIds: [profile.device.deviceId] }
  })
  const rusty = await startRustyService(owner, baseURL!)
  let rustyStopped = false
  const editorContext = await browser.newContext(), visitorContext = await browser.newContext()
  try {
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const editor = await editorContext.newPage(), visitor = await visitorContext.newPage()
    await join(page, editor, "editor", false)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const storage = page.getByRole("region", { name: "Rusty", exact: true })
    await storage.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await storage.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await storage.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(storage.getByText("Synced", { exact: true }).first()).toBeVisible({ timeout: 30_000 })
    await expect(editor.getByRole("region", { name: "Rusty", exact: true }).getByText("Board access · read and write", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await join(page, visitor, "visitor")
    const states = await Promise.all([editorContext.storageState({ indexedDB: true }), visitorContext.storageState({ indexedDB: true })])
    const boardURL = editor.url()
    await page.close()
    await editorContext.close(); await visitorContext.close()
    const coldContexts = await Promise.all(states.map(storageState => browser.newContext({ storageState })))
    try {
      // Cold contexts have no pre-existing WebRTC paths. Block relay WebSockets before startup.
      for (const context of coldContexts) await context.routeWebSocket("**/*", socket => socket.close())
      const [writer, reader] = await Promise.all(coldContexts.map(context => context.newPage()))
      const readerWrites: string[] = []
      reader!.on("request", request => {
        if (request.url().startsWith(rusty.origin) && request.method() === "PUT") readerWrites.push(request.url())
      })
      await Promise.all([writer!.goto(boardURL), reader!.goto(boardURL)])
      await expect(writer!.getByLabel("Workspace role: editor")).toBeVisible({ timeout: 30_000 })
      await writer!.evaluate(async () => {
        const app = (await import("/src/test/stateFixture.ts")).useTincanban()
        await app.executeCommandAsync({ kind: "createItem", parentId: app.genericColumns.value[0]!.id, title: "Owner asleep, Rusty delivered" })
      })
      await expect(reader!.getByRole("button", { name: "Open Owner asleep, Rusty delivered", exact: true }))
        .toBeVisible({ timeout: 35_000 })
      await reader!.getByRole("button", { name: "Sync", exact: true }).click()
      await expect(reader!.getByRole("region", { name: "Rusty", exact: true }).getByText("Synced", { exact: true })).toBeVisible()
      expect(readerWrites).toEqual([])
      await reader!.screenshot({ path: testInfo.outputPath("visitor-rusty-owner-offline.png") })
      await rusty.close()
      rustyStopped = true
      await reader!.getByRole("region", { name: "Rusty", exact: true }).getByRole("button", { name: "Sync now", exact: true }).click()
      await expect(reader!.getByRole("region", { name: "Rusty", exact: true }).getByText("Unavailable", { exact: true })).toBeVisible()
      await reader!.screenshot({ path: testInfo.outputPath("visitor-rusty-unavailable.png") })
    } finally { for (const context of coldContexts) await context.close() }
  } finally {
    await editorContext.close(); await visitorContext.close()
    if (!rustyStopped) await rusty.close()
  }
})
