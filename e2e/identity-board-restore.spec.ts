import { expect, test, type Page } from "./support/coverage"
import { startIdentityRustyService } from "./support/rustyService"

test.use({ trace: "off", video: "off", screenshot: "off", actionTimeout: 15_000 })
const identityOrigin = process.env.IDENTITY_E2E_ORIGIN

test.skip(!identityOrigin, "A local Identity portal is required")

async function approve(page: Page) {
  await page.getByRole("heading", { name: "Authorize app device", exact: true }).waitFor()
  await page.getByLabel(/Allow this app/).check()
  await page.getByRole("button", { name: /^(Approve app device|Approve device and link services)$/ }).click()
  await page.waitForURL(url => url.origin !== identityOrigin)
}

test("Given remotely saved boards and the source device closed, when ordinary Identity login runs on a clean app device, then original cards load after interrupted restore and survive reload", async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const source = await browser.newContext()
  const page = await source.newPage()
  let rusty: Awaited<ReturnType<typeof startIdentityRustyService>> | undefined
  try {
    await page.goto(identityOrigin!)
    await page.getByRole("button", { name: "Create identity", exact: true }).click()
    await page.locator('#create-form input[name="displayName"]').fill("Board restoration owner")
    await page.locator("#create-form").getByRole("button", { name: "Create identity", exact: true }).click()
    await page.getByRole("heading", { name: "Save your recovery" }).waitFor()
    const download = page.waitForEvent("download")
    await page.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
    await download
    await page.locator('input[name="saved-words"]').check()
    await page.getByRole("button", { name: "Continue to identity", exact: true }).click()
    await page.goto(baseURL!)
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await approve(page)
    await expect(page.getByRole("dialog", { name: "Identity profile", exact: true })).toBeHidden({ timeout: 30_000 })
    await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
    await page.getByRole("button", { name: "New workspace", exact: true }).click()
    const create = page.getByRole("dialog", { name: "Create workspace" })
    await create.getByLabel("Title", { exact: true }).fill("Original restored board")
    await create.getByRole("button", { name: "Create", exact: true }).click()
    await page.getByRole("region", { name: "Original restored board", exact: true }).waitFor()
    await page.getByRole("button", { name: "Add item to To do" }).click()
    const item = page.getByRole("dialog", { name: "Item details" })
    await item.getByLabel("Title *").fill("Recovered card")
    await item.getByRole("button", { name: "Save item" }).click()
    const originalWorkspaceId = await page.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)
    rusty = await startIdentityRustyService(new URL(baseURL!).origin)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const panel = page.getByRole("dialog", { name: "Device sync" }).getByRole("region", { name: "Rusty", exact: true })
    await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await panel.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    await approve(page)
    if (!await page.getByRole("dialog", { name: "Device sync" }).isVisible()) await page.getByRole("button", { name: "Sync", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Device sync" }).getByRole("region", { name: "Rusty", exact: true })).toContainText("Synced", { timeout: 45_000 })
    await panel.getByRole("button", { name: "Sync now", exact: true }).click()
    await expect(page.locator(".rusty-profile-connection").getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    const state = await source.storageState({ indexedDB: true })
    state.origins = state.origins.filter(origin => origin.origin === identityOrigin)
    state.cookies = []
    await source.close()
    const target = await browser.newContext({ storageState: state })
    try {
      const fresh = await target.newPage()
      await target.route(`${rusty.origin}/v2/scopes/**`, route => new URL(fresh.url()).origin === new URL(baseURL!).origin ? route.abort() : route.continue())
      await fresh.goto(baseURL!)
      await fresh.getByRole("button", { name: "Sign in", exact: true }).click()
      await approve(fresh)
      await expect(fresh.getByRole("alert")).toContainText(/could not finish loading your boards/i, { timeout: 30_000 })
      await target.unroute(`${rusty.origin}/v2/scopes/**`)
      await fresh.setViewportSize({ width: 390, height: 844 })
      await fresh.getByRole("dialog", { name: "Identity profile", exact: true }).getByRole("button", { name: "Sign in", exact: true }).click()
      await approve(fresh)
      await expect(fresh.getByRole("region", { name: "Original restored board", exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(fresh.getByRole("button", { name: "Open Recovered card", exact: true })).toBeVisible()
      await fresh.reload()
      await expect(fresh.getByRole("region", { name: "Original restored board", exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(fresh.getByRole("button", { name: "Open Recovered card", exact: true })).toBeVisible()
      expect(await fresh.evaluate(async () => (await (await import("/src/storage.ts")).defaultStorage.listWorkspaces()).find(item => item.title === "Original restored board")?.id)).toBe(originalWorkspaceId)
    } finally { await target.close() }
  } finally { await source.close(); await rusty?.close() }
})
