import { createDeviceAuthorizationApproval, createRecoverableIdentity, parseDeviceAuthorizationRequest } from "@meta-uber/mesh-identity"
import { expect, test, type Page } from "./support/coverage"

test.use({ trace: "off", video: "off", screenshot: "off" })

const identityOrigin = process.env.IDENTITY_E2E_ORIGIN

test.skip(!identityOrigin, "Set IDENTITY_E2E_ORIGIN to a running Identity portal preview")

test("Given a local app device and saved board, when Identity approves browser sign-in, then return with the approved identity and preserved board", async ({ page, context }) => {
  test.setTimeout(120_000)
  const appUrl = process.env.TINCANBAN_E2E_ORIGIN ?? `http://127.0.0.1:${process.env.TINCANBAN_E2E_PORT ?? 4244}`
  const portal = await context.newPage()
  const createPortalIdentity = async (target: Page, displayName: string) => {
    await target.goto(identityOrigin!)
    await target.getByRole("button", { name: "Create identity", exact: true }).click()
    await target.locator('#create-form input[name="displayName"]').fill(displayName)
    await target.locator("#create-form").getByRole("button", { name: "Create identity", exact: true }).click()
    await target.getByRole("heading", { name: "Save your recovery" }).waitFor()
    const downloadEvent = target.waitForEvent("download")
    await target.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
    await downloadEvent
    await target.locator('input[name="saved-words"]').check()
    await target.getByRole("button", { name: "Continue to identity", exact: true }).click()
    await target.getByRole("heading", { name: displayName }).waitFor()
    return { identityId: await target.locator(".identity-id-badge").getAttribute("data-identity-id") }
  }
  const { identityId } = await createPortalIdentity(portal, "Browser Login Owner")
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
  const retainedWorkspaceId = await page.evaluate(async title => {
    const workspaces = await (await import("/src/storage.ts")).defaultStorage.listWorkspaces()
    return workspaces.find(workspace => workspace.title === title)?.id ?? null
  }, "Board survives browser login")
  expect(retainedWorkspaceId).toBeTruthy()
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
  const savedReturnPath = `${new URL(page.url()).pathname}${new URL(page.url()).search}`
  expect(savedReturnPath).toMatch(/^\/boards\/[a-f0-9-]{36}\/board-survives-browser-login$/u)

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
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe(savedReturnPath)
  const failedSignIn = page.getByRole("dialog", { name: "Identity profile", exact: true })
  await expect(failedSignIn.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible()
  await expect(failedSignIn.getByRole("alert")).toHaveText("Identity approval was not granted. Select Sign in to try again.")
  await expect(failedSignIn.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled()
  await expect(failedSignIn.getByLabel("Identity invitation")).toHaveCount(0)
  expect(await page.evaluate(async () => (await (await import("/src/domain/identity.ts")).bootstrapIdentity()).identity.personId)).toBe(localBefore)

  await failedSignIn.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
  await page.getByLabel("Allow this app to use the Identity shown above.").check()
  await page.getByRole("button", { name: "Approve app device", exact: true }).click()

  await page.waitForURL(new RegExp(`^${appUrl.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/identity/return`), { timeout: 30000 })
  const replacement = page.getByRole("dialog", { name: "Identity profile", exact: true })
  await expect(replacement.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible()
  await expect(replacement.getByRole("heading", { name: "Add another device", exact: true })).toHaveCount(0)
  await expect(replacement.getByLabel("Identity invitation")).toHaveCount(0)
  await expect(replacement.getByRole("heading", { name: "Join Browser Login Owner?" })).toBeVisible()
  await expect(replacement.getByText("Board survives browser login")).toBeVisible()
  await replacement.getByRole("button", { name: "Download active workspace backup", exact: true }).click()
  await replacement.getByLabel("I understand this changes the active Identity and may leave local boards inaccessible.").check()
  await replacement.getByRole("button", { name: "Continue with this Identity", exact: true }).click()
  await expect(replacement).toHaveCount(0)
  await expect.poll(async () => await page.evaluate(async () => (await (await import("/src/domain/identity.ts")).bootstrapIdentity()).identity.personId)).toBe(identityId)
  await expect(page.getByRole("region", { name: "Board survives browser login", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const identitySettings = page.getByRole("group", { name: "Your profile", exact: true })
  await expect(identitySettings.getByRole("textbox", { name: "Name", exact: true })).toBeEnabled()
  await expect(identitySettings.getByText("Loading saved profile…", { exact: true })).toHaveCount(0)
  await page.goto(appUrl)
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const restoredSettings = page.getByRole("group", { name: "Your profile", exact: true })
  await expect(restoredSettings.getByRole("textbox", { name: "Name", exact: true })).toBeEnabled()
  await expect(restoredSettings.getByText("Loading saved profile…", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Dismiss", exact: true }).click()
  const after = await page.evaluate(async personId => {
    const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
    const previous = await (await import("/src/localDb.ts")).readLocal(`tincanban.local_profile.v1.backup.${personId}`)
    const persisted = await (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1")
    const rootsRaw = await (await import("/src/localDb.ts")).readLocal("tincanban.v1.personal_roots")
    const rootPeople = Object.values(JSON.parse(rootsRaw ?? "{}") as Record<string, { identity: { personId: string } }>).map(root => root.identity.personId)
    return { personId: profile.identity.personId, rootKey: Boolean(profile.privateKeys.identityPrivateKey), deviceId: profile.device.deviceId,
      backedUpPersonId: previous ? JSON.parse(previous).identity.personId : null,
      persistedPersonId: persisted ? JSON.parse(persisted).identity.personId : null, rootPeople }
  }, localBefore)
  const retainedBoard = await page.evaluate(async workspaceId => {
    const loaded = await (await import("/src/storage.ts")).defaultStorage.loadWorkspaceDoc(workspaceId)
    return loaded ? { owner: loaded.doc.ownerPersonId, title: loaded.doc.title } : null
  }, retainedWorkspaceId)
  expect(retainedBoard).toEqual({ owner: localBefore, title: "Board survives browser login" })
  expect(after.backedUpPersonId).toBe(localBefore)
  expect(after.persistedPersonId).toBe(identityId)
  expect(after.personId).toBe(identityId)
  expect(after.rootKey).toBe(false)
  expect(after.deviceId).not.toBe("")
  expect(after.rootPeople).toContain(localBefore)
  expect(after.rootPeople).toContain(identityId)

  const replacementIdentity = await createRecoverableIdentity("better", "Replacement Sign-in Owner")
  expect(replacementIdentity.profile.identity.personId).not.toBe(identityId)

  await page.getByRole("button", { name: "Identity", exact: true }).click()
  const keepReturnPath = `${new URL(page.url()).pathname}${new URL(page.url()).search}`
  await page.getByRole("dialog", { name: "Identity profile", exact: true })
    .getByRole("button", { name: "Sign in", exact: true }).click()
  await page.waitForURL(new RegExp(`^${identityOrigin!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/authorize`), { timeout: 30000 })
  const requestHash = new URL(page.url()).hash
  const requestEncoded = new URLSearchParams(requestHash.slice(1)).get("device-request")
  expect(requestEncoded).toBeTruthy()
  const request = await parseDeviceAuthorizationRequest(requestEncoded!)
  expect(request.payload.applicationOrigin).toBe(new URL(appUrl).origin)
  const approval = await createDeviceAuthorizationApproval(replacementIdentity.profile, request, {
    applicationOrigin: new URL(appUrl).origin,
    challenge: request.payload.challenge,
  })
  const approvalEncoded = Buffer.from(JSON.stringify(approval)).toString("base64url")
  await page.goto(`${new URL(appUrl).origin}/identity/return#${new URLSearchParams({
    state: request.payload.challenge,
    approval: approvalEncoded,
  }).toString()}`)
  const keepIdentity = page.getByRole("dialog", { name: "Identity profile", exact: true })
  const replacementPrompt = keepIdentity.getByRole("region", { name: "Replace local Identity confirmation" })
  await expect(replacementPrompt.getByRole("heading", { name: "Join Replacement Sign-in Owner?" })).toBeVisible()
  await replacementPrompt.getByRole("button", { name: "Keep current Identity", exact: true }).click()
  await expect.poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`).toBe(keepReturnPath)
  await expect(keepIdentity.getByRole("status")).toHaveText("Kept the current Identity. No local data changed.")
  await expect(keepIdentity.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled()
  await expect(keepIdentity.getByLabel("Identity invitation")).toHaveCount(0)
  await expect.poll(async () => await page.evaluate(async () => (await (await import("/src/domain/identity.ts")).bootstrapIdentity()).identity.personId)).toBe(identityId)
  const boardAfterKeep = await page.evaluate(async workspaceId => {
    const loaded = await (await import("/src/storage.ts")).defaultStorage.loadWorkspaceDoc(workspaceId)
    return loaded ? { owner: loaded.doc.ownerPersonId, title: loaded.doc.title } : null
  }, retainedWorkspaceId)
  expect(boardAfterKeep).toEqual({ owner: localBefore, title: "Board survives browser login" })
  await portal.close()
})
