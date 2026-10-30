import { expect, test } from "./support/coverage"
import { populatedBoard } from "./support/detailedBoard"

test.use({ trace: "off" })

test("Given chat metadata becomes unavailable, when Chat opens, then failure appears and board remains usable", async ({ page }) => {
  await populatedBoard(page)
  await page.evaluate(async () => {
    const { configureChat } = await import("/src/chat/service.ts")
    configureChat(async () => "owner", async () => { throw new Error("Workspace metadata unavailable") })
  })
  await page.getByRole("button", { name: "Workspace chat", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await expect(dialog.getByRole("alert")).toContainText("Workspace metadata unavailable")
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Item overview" })).toBeVisible()
})

test("Given the Chat chunk fails after loading is delayed, when Chat opens, then reload recovers chat", async ({ page }) => {
  let releaseChunk!: () => void
  const chunkGate = new Promise<void>(resolve => { releaseChunk = resolve })
  let firstRequest = true
  await page.route("**/src/components/WorkspaceChat.vue*", async route => {
    await chunkGate
    if (firstRequest) {
      firstRequest = false
      await route.abort()
    } else await route.continue()
  })
  await populatedBoard(page)
  await page.getByRole("button", { name: "Workspace chat", exact: true }).click()
  const pending = page.locator(".chat-open-pending")
  await expect(pending).toContainText("Opening chat…")
  releaseChunk()
  const failed = page.getByRole("alert").filter({ hasText: "Chat could not load." })
  await expect(failed).toBeVisible()
  await failed.getByRole("button", { name: "Reload tincanban" }).click()
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 60_000 })
  await page.getByRole("button", { name: "Workspace chat", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Workspace chat", exact: true })).toBeVisible()
})

test("Given Sync chunk fails to load, when Sync opens, then pending can close and reload recovers", async ({ page }) => {
  test.setTimeout(120_000)
  let firstLoad = true
  await page.route("**/src/components/SyncDialog.vue*", async route => {
    if (firstLoad) {
      firstLoad = false
      await new Promise(resolve => setTimeout(resolve, 800))
      await route.abort()
    } else await route.continue()
  })
  await populatedBoard(page)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync", exact: true })
  await expect(dialog.getByRole("status")).toContainText("Loading sync controls")
  await dialog.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  const itemDialogAfterPendingClose = page.getByRole("dialog", { name: "Item overview" })
  await expect(itemDialogAfterPendingClose).toBeVisible()
  await itemDialogAfterPendingClose.getByRole("button", { name: "Close detail", exact: true }).click()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const failedDialog = page.getByRole("dialog", { name: "Device sync", exact: true })
  await expect(failedDialog.getByRole("alert")).toContainText("Sync controls could not load")
  await expect(failedDialog.getByRole("button", { name: "Reload tincanban", exact: true })).toBeVisible()
  await failedDialog.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  const itemDialog = page.getByRole("dialog", { name: "Item overview" })
  await expect(itemDialog).toBeVisible()
  await itemDialog.getByRole("button", { name: "Close detail", exact: true }).click()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await page.getByRole("dialog", { name: "Device sync", exact: true }).getByRole("button", { name: "Reload tincanban", exact: true }).click()
  // Recovery waits for full-history admission; the pending Sync state remains asserted above.
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 60_000 })
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await expect(page.locator(".sync-dialog")).toBeVisible()
})
