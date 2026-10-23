import { expect, test } from "./support/coverage"

test.use({ trace: "off", video: "off", screenshot: "off" })

const identityOrigin = process.env.IDENTITY_E2E_ORIGIN

test.skip(!identityOrigin, "Set IDENTITY_E2E_ORIGIN to a running Identity portal preview")

test("Given a local app device and saved board, when Identity approves browser sign-in, then return with the approved identity and preserved board", async ({ page, context }) => {
  test.setTimeout(120_000)
  const appUrl = process.env.TINCANBAN_E2E_ORIGIN ?? `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? 4244}`
  const portal = await context.newPage()
  await portal.goto(identityOrigin!)
  await portal.getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.locator('#create-form input[name="displayName"]').fill("Browser Login Owner")
  await portal.locator("#create-form").getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.getByRole("heading", { name: "Save your recovery" }).waitFor()
  const downloadEvent = portal.waitForEvent("download")
  await portal.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
  await downloadEvent
  await portal.locator('input[name="saved-words"]').check()
  await portal.getByRole("button", { name: "Continue to identity", exact: true }).click()
  await portal.getByRole("heading", { name: "Browser Login Owner" }).waitFor()
  const identityId = await portal.locator(".identity-id-badge").getAttribute("data-identity-id")
  expect(identityId).toBeTruthy()

  await page.goto(appUrl)
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  const localBefore = await page.evaluate(async () => (await (await import("/src/domain/identity.ts")).bootstrapIdentity()).identity.personId)
  expect(localBefore).not.toBe(identityId)
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
  await page.getByRole("button", { name: "New workspace", exact: true }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Board survives browser login")
  await create.getByRole("button", { name: "Create", exact: true }).click()
  const board = page.getByRole("region", { name: "Board survives browser login", exact: true })
  await board.waitFor()
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()

  const openSignIn = async () => {
    await page.getByRole("button", { name: "Identity", exact: true }).click()
    await page.getByRole("dialog", { name: "Identity profile", exact: true }).getByRole("button", { name: "Sign in", exact: true }).click()
  }

  await page.getByRole("button", { name: "Identity", exact: true }).click()
  const options = page.getByRole("dialog", { name: "Identity profile", exact: true })
  await options.getByRole("button", { name: "Add another device", exact: true }).click()
  const connectForm = options.locator(".identity-device-connect-form")
  await expect(connectForm).toHaveCSS("display", "grid")
  await expect(connectForm.locator(".identity-device-field")).toHaveCount(2)
  await expect(connectForm.locator(".identity-device-consent")).toHaveCSS("display", "grid")
  await expect(connectForm.getByLabel("Identity invitation")).toBeVisible()
  await expect(connectForm.getByLabel("Device name")).toBeVisible()
  await options.getByRole("button", { name: "Back to Identity options", exact: true }).click()

  await openSignIn()
  await expect(page).toHaveURL(new RegExp(`^${identityOrigin!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}.*`))
  await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
  await expect(page.getByText(new URL(appUrl).origin, { exact: false })).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.waitForURL(new RegExp(`^${appUrl.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/identity/return`), { timeout: 30000 })
  const failedSignIn = page.getByRole("dialog", { name: "Identity profile", exact: true })
  await expect(failedSignIn.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible()
  await expect(failedSignIn.getByRole("alert")).toContainText("cancelled")
  await expect(failedSignIn.getByLabel("Identity invitation")).toHaveCount(0)
  expect(await page.evaluate(async () => (await (await import("/src/domain/identity.ts")).bootstrapIdentity()).identity.personId)).toBe(localBefore)

  await failedSignIn.getByRole("button", { name: "Try sign in again", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`^${identityOrigin!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}.*`))
  await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.waitForURL(new RegExp(`^${appUrl.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/identity/return`), { timeout: 30000 })
  await expect(failedSignIn.getByRole("alert")).toContainText("cancelled")
  await failedSignIn.getByRole("button", { name: "Cancel sign in", exact: true }).click()
  await openSignIn()
  await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
  await page.getByLabel("Allow this app to use the Identity shown above.").check()
  await page.getByRole("button", { name: "Approve app device", exact: true }).click()

  await page.waitForURL(new RegExp(`^${appUrl.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/identity/return`), { timeout: 30000 })
  const replacement = page.getByRole("dialog", { name: "Identity profile", exact: true })
  await expect(replacement.getByRole("heading", { name: "Join Browser Login Owner?" })).toBeVisible()
  await expect(replacement.getByText("Board survives browser login")).toBeVisible()
  await replacement.getByRole("button", { name: "Download active workspace backup", exact: true }).click()
  await replacement.getByLabel("I understand this changes the active Identity and may leave local boards inaccessible.").check()
  await replacement.getByRole("button", { name: "Continue with this Identity", exact: true }).click()
  await expect(replacement).toHaveCount(0)
  await expect.poll(async () => await page.evaluate(async () => (await (await import("/src/domain/identity.ts")).bootstrapIdentity()).identity.personId)).toBe(identityId)
  await expect(page.getByRole("region", { name: "Board survives browser login", exact: true })).toBeVisible()
  const after = await page.evaluate(async personId => {
    const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
    const previous = await (await import("/src/localDb.ts")).readLocal(`tincanban.local_profile.v1.backup.${personId}`)
    const persisted = await (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1")
    return { personId: profile.identity.personId, rootKey: Boolean(profile.privateKeys.identityPrivateKey), deviceId: profile.device.deviceId,
      backedUpPersonId: previous ? JSON.parse(previous).identity.personId : null,
      persistedPersonId: persisted ? JSON.parse(persisted).identity.personId : null }
  }, localBefore)
  expect(after.backedUpPersonId).toBe(localBefore)
  expect(after.persistedPersonId).toBe(identityId)
  expect(after.personId).toBe(identityId)
  expect(after.rootKey).toBe(false)
  expect(after.deviceId).not.toBe("")
  await portal.close()
})
