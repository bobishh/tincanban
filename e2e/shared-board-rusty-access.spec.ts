import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { startIdentityRustyService } from "./support/rustyService"

const identityOrigin = process.env.IDENTITY_E2E_ORIGIN

async function createSignedInIdentity(context: BrowserContext, page: Page, displayName: string): Promise<string> {
  context.setDefaultTimeout(20_000)
  page.setDefaultTimeout(20_000)
  const portal = await context.newPage()
  await portal.goto(identityOrigin!)
  await portal.getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.locator('#create-form input[name="displayName"]').fill(displayName)
  await portal.locator("#create-form").getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.getByRole("heading", { name: "Save your recovery" }).waitFor()
  const download = portal.waitForEvent("download")
  await portal.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
  await download
  await portal.locator('input[name="saved-words"]').check()
  await portal.getByRole("button", { name: "Continue to identity", exact: true }).click()
  await portal.getByRole("heading", { name: displayName, exact: true }).waitFor()
  const personId = await portal.locator(".identity-id-badge").getAttribute("data-identity-id")
  expect(personId).toBeTruthy()

  await page.goto("/")
  const appOrigin = new URL(page.url()).origin
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
  await page.getByLabel("Allow this app to use the Identity shown above.").check()
  await page.getByRole("button", { name: "Approve app device", exact: true }).click()
  await page.waitForURL(url => url.origin === appOrigin && url.pathname === "/identity/return", { timeout: 30_000 })
  const replacement = page.getByRole("dialog", { name: "Identity profile", exact: true })
  const replacementConsent = replacement.getByLabel("I understand this changes the active Identity and may leave local boards inaccessible.")
  const appPersonId = () => page.evaluate(async () => (await import("/src/domain/identity.ts")).bootstrapIdentity().then(profile => profile.identity.personId))
  await expect.poll(async () => await replacementConsent.isVisible().catch(() => false) || await appPersonId() === personId, { timeout: 30_000 }).toBe(true)
  if (await replacementConsent.isVisible().catch(() => false)) {
    await replacementConsent.check()
    await replacement.getByRole("button", { name: "Continue with this Identity", exact: true }).click()
  }
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0)
  await expect.poll(appPersonId, { timeout: 30_000 }).toBe(personId)
  return personId!
}

async function join(owner: Page, guest: Page, role: "editor" | "visitor") {
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
  if (await joining.isVisible()) await joining.getByRole("button", { name: "Close", exact: true }).click()
  await host.getByRole("button", { name: "Close", exact: true }).click()
  await guest.getByRole("button", { name: "Sync", exact: true }).click()
  const storage = guest.getByRole("region", { name: "Rusty", exact: true })
  await storage.locator(".rusty-connection").click()
  await expect(storage.getByText(role === "editor" ? "Board access · read and write" : "Board access · read only", { exact: true }))
    .toBeVisible({ timeout: 30_000 })
  await expect(storage.getByRole("button", { name: "Add Rusty", exact: true })).toHaveCount(0)
  await expect(storage.locator(".rusty-profile-status")).toHaveCount(0)
}

test("Given three distinct identities and owner-configured Rusty, when owner closes and peer routes are disabled, then editor publishes and visitor reads via Rusty only", async ({ page, browser, baseURL }, testInfo) => {
  test.setTimeout(300_000)
  if (!identityOrigin) throw new Error("Set IDENTITY_E2E_ORIGIN to the pinned local Identity E2E server")
  page.setDefaultTimeout(20_000)
  const ownerId = await createSignedInIdentity(page.context(), page, "Rusty Board Owner")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 25_000 })
  const workspaceId = await page.evaluate(async () => {
    const doc = await (await import("/src/state.ts")).useTincanban().createWorkspaceAsync("Shared Rusty acceptance", "blank")
    return doc.id
  })
  await expect.poll(() => page.evaluate(async id => {
    const { peerStore } = await import("/src/sync/peerStore.ts")
    return Boolean((await peerStore.getWorkspaceAuthority(id))?.scopeAuthoritySnapshot)
  }, workspaceId)).toBe(true)
  const rusty = await startIdentityRustyService(`${baseURL},${identityOrigin}`)
  let rustyStopped = false
  const editorContext = await browser.newContext(), visitorContext = await browser.newContext()
  try {
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const editor = await editorContext.newPage(), visitor = await visitorContext.newPage()
    const editorId = await createSignedInIdentity(editorContext, editor, "Rusty Board Editor")
    const visitorId = await createSignedInIdentity(visitorContext, visitor, "Rusty Board Visitor")
    expect(new Set([ownerId, editorId, visitorId]).size).toBe(3)
    const storage = page.getByRole("region", { name: "Rusty", exact: true })
    const appOrigin = new URL(page.url()).origin
    await storage.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await storage.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await storage.getByRole("button", { name: "Connect", exact: true }).click()
    await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
    await page.getByLabel("Allow this app device and add the listed verified Rusty service keys to the shared Identity catalog.").check()
    await page.getByRole("button", { name: "Approve device and link services", exact: true }).click()
    await page.waitForURL(url => url.origin === appOrigin && url.pathname !== "/identity/return", { timeout: 30_000 })
    await expect.poll(() => page.evaluate(async () => (await import("/src/domain/identity.ts")).bootstrapIdentity().then(profile => profile.identity.personId)),
      { timeout: 30_000 }).toBe(ownerId)
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await expect(storage.getByText("Synced", { exact: true }).first()).toBeVisible({ timeout: 30_000 })
    await join(page, editor, "editor")
    await expect(editor.getByRole("region", { name: "Rusty", exact: true }).getByText("Board access · read and write", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await page.getByRole("button", { name: "Sync", exact: true }).click()
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
      const offlineStorage = reader!.getByRole("region", { name: "Rusty", exact: true })
      await expect(offlineStorage.getByText("Unavailable", { exact: true })).toBeVisible({ timeout: 20_000 })
      await offlineStorage.locator(".rusty-connection").click()
      await expect(offlineStorage.getByRole("alert")).toContainText("Rusty connection unavailable. Retry sync.")
      await expect(reader!.getByRole("button", { name: "Open Owner asleep, Rusty delivered", exact: true })).toBeVisible()
      expect(readerWrites).toEqual([])
      await reader!.screenshot({ path: testInfo.outputPath("visitor-rusty-unavailable.png") })
    } finally { for (const context of coldContexts) await context.close() }
  } finally {
    await editorContext.close(); await visitorContext.close()
    if (!rustyStopped) await rusty.close()
  }
})
