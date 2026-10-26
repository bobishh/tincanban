import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"
import { startRustyService } from "./support/rustyService"

const identityOrigin = process.env.IDENTITY_E2E_ORIGIN
test.skip(!identityOrigin, "Set IDENTITY_E2E_ORIGIN to an isolated Identity server")

test("Given a signed-in board owner, when approving Add Rusty in Identity, then return to the same board and connect storage automatically", async ({ page, context, baseURL }) => {
  test.setTimeout(120_000)
  const portal = await context.newPage()
  await portal.goto(identityOrigin!)
  await portal.getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.locator('#create-form input[name="displayName"]').fill("Storage Owner")
  await portal.locator("#create-form").getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.getByRole("heading", { name: "Save your recovery" }).waitFor()
  const download = portal.waitForEvent("download")
  await portal.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
  await download
  await portal.locator('input[name="saved-words"]').check()
  await portal.getByRole("button", { name: "Continue to identity", exact: true }).click()

  await page.goto("/")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
  await page.getByLabel("Allow this app to use the Identity shown above.").check()
  await page.getByRole("button", { name: "Approve app device", exact: true }).click()
  const replacement = page.getByRole("dialog", { name: "Identity profile", exact: true })
  await replacement.getByLabel("I understand this changes the active Identity and may leave local boards inaccessible.").check()
  await replacement.getByRole("button", { name: "Continue with this Identity", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await expect(page.getByRole("region", { name: "Your profile", exact: true })).toContainText("Storage Owner")
  await page.getByRole("button", { name: "Dismiss", exact: true }).click()
  await createJobSearchWorkspace(page, "Connected board")
  const boardUrl = page.url()
  const rusty = await startRustyService({}, `${baseURL},${identityOrigin}`)
  try {
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const storage = page.getByRole("region", { name: "Rusty", exact: true })
    await storage.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await storage.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await storage.getByRole("button", { name: "Connect", exact: true }).click()
    await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
    await page.getByLabel("Allow this app device and add the listed verified Rusty service keys to the shared Identity catalog.").check()
    await page.getByRole("button", { name: "Approve device and link services", exact: true }).click()
    await expect(page).toHaveURL(boardUrl)
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await expect(storage.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await page.reload()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await expect(storage.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
  } finally {
    await rusty.close()
    await portal.close()
  }
})
