import { createRecoverableIdentity, createDeviceAuthorizationApproval, createIdentityProfileOperation,
  emptyIdentityProfileState, parseDeviceAuthorizationRequest, readIdentityProfileState } from "@meta-uber/mesh-identity"
import { expect, test, type Page } from "./support/coverage"
import { addJobSearchLead, createJobSearchWorkspace, ensureJobSearchWorkspace } from "./support/workspaces"

// Pairing and Identity approvals contain credentials; keep them out of test artifacts.
test.use({ trace: "off", video: "off", screenshot: "off", actionTimeout: 15_000 })
const identityOrigin = process.env.IDENTITY_E2E_ORIGIN

test("Given a disconnected phone and a browser without enrollment rights, when the phone signs in and reconnects, then catch up fresh cards in both directions without losing local boards", async ({ page: source, browser, baseURL }, testInfo) => {
  test.skip(!identityOrigin, "A configured Identity origin is required")
  test.setTimeout(180_000)
  const identity = (await createRecoverableIdentity("better", "Reconnecting phone owner")).profile
  const initial = emptyIdentityProfileState(identity.identity.personId)
  const name = await createIdentityProfileOperation(identity, initial, "name", identity.identity.displayName)
  const profileState = await readIdentityProfileState({ ...initial, operations: [name] }, identity.identity)
  const certificates = [identity.certificate]
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const phone = await phoneContext.newPage()
  const approve = async (page: Page, cancel = false) => {
    await page.waitForURL(url => url.origin === identityOrigin)
    const request = await parseDeviceAuthorizationRequest(new URLSearchParams(new URL(page.url()).hash.slice(1)).get("device-request")!)
    expect(request.payload.applicationOrigin).toBe(new URL(baseURL!).origin)
    expect(request.payload.personId).toBe(page === phone ? identity.identity.personId : null)
    if (cancel) {
      await page.goto(`${baseURL}/identity/return#${new URLSearchParams({ state: request.payload.challenge, cancelled: "1" })}`)
      return
    }
    const approval = await createDeviceAuthorizationApproval(identity, request, {
      applicationOrigin: request.payload.applicationOrigin, challenge: request.payload.challenge,
      certificates, revocations: [], profileState, includeProfileState: true, identityCatalogAccess: [],
    })
    certificates.push(approval.certificate)
    await page.goto(`${baseURL}/identity/return#${new URLSearchParams({ state: request.payload.challenge,
      approval: Buffer.from(JSON.stringify(approval)).toString("base64url") })}`)
    const dialog = page.getByRole("dialog", { name: "Identity profile", exact: true })
    const add = dialog.getByRole("button", { name: "Add boards and sign in", exact: true })
    await expect.poll(async () => await add.isVisible() || await page.evaluate(async personId => {
      const app = (await import("/src/state.ts")).useTincanban()
      return app.getCurrentProfile()?.identity.personId === personId
    }, identity.identity.personId)).toBe(true)
    if (await add.isVisible()) await add.click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
  }
  try {
    for (const page of [source, phone]) await page.route(`${identityOrigin}/authorize**`, route => route.fulfill({ contentType: "text/html", body: "Identity authorization fixture" }))
    await source.goto("/")
    await source.getByRole("button", { name: "Sign in", exact: true }).click()
    await approve(source)
    expect(await source.evaluate(async () => (await import("/src/state.ts")).useTincanban().getCurrentProfile()!.certificate.payload.canEnrollDevices)).toBe(false)
    await ensureJobSearchWorkspace(source)
    await addJobSearchLead(source, "Retained source card")
    const originalBoardPath = new URL(source.url()).pathname
    await phone.goto("/")
    await createJobSearchWorkspace(phone, "Phone retained board")
    await addJobSearchLead(phone, "Phone local card")
    await source.getByRole("button", { name: "Sync", exact: true }).click()
    await source.getByRole("button", { name: "Add my device", exact: true }).click()
    const host = source.getByRole("dialog", { name: "Device sync", exact: true })
    const link = host.getByLabel("Pairing link", { exact: true })
    await expect(link).toHaveValue(/\/pair#/u, { timeout: 30_000 })
    const invitation = await link.inputValue()
    await phone.goto(invitation)
    const guest = phone.getByRole("dialog", { name: "Device sync", exact: true })
    const signIn = guest.getByRole("button", { name: "Sign in to reconnect", exact: true })
    await expect(signIn).toBeVisible()
    await expect(guest.getByRole("button", { name: "Add this device", exact: true })).toHaveCount(0)
    await signIn.click()
    await approve(phone, true)
    const cancelled = phone.getByRole("dialog", { name: "Identity profile", exact: true })
    await expect(cancelled.getByRole("alert")).toContainText("not granted")
    await cancelled.getByRole("button", { name: "Close", exact: true }).last().click()
    await expect(signIn).toBeVisible()
    expect(phone.url()).toBe(invitation)
    await signIn.click()
    await approve(phone, true)
    await cancelled.getByRole("button", { name: "Sign in", exact: true }).click()
    await approve(phone)
    expect(phone.url()).toBe(invitation)
    await expect(guest.getByRole("button", { name: "Add this device", exact: true })).toBeVisible()
    await guest.getByRole("button", { name: "Add this device", exact: true }).click()
    await expect(host.getByText("This device is already in your Identity.", { exact: false })).toBeVisible({ timeout: 40_000 })
    await host.getByRole("button", { name: "Approve device", exact: true }).click()
    await expect(guest.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 60_000 })
    await guest.getByRole("button", { name: "Close", exact: true }).first().click()
    await host.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(phone.getByRole("button", { name: "Open Retained source card — Engineer", exact: true })).toBeVisible()
    expect(new URL(phone.url()).pathname).toBe(originalBoardPath)
    await phoneContext.setOffline(true)
    await addJobSearchLead(source, "New while phone was behind")
    await addJobSearchLead(phone, "New saved on disconnected phone")
    await expect(source.getByRole("button", { name: "Open New saved on disconnected phone — Engineer", exact: true })).toHaveCount(0)
    await phoneContext.setOffline(false)
    await phone.reload()
    await expect(phone.getByRole("button", { name: "Open New while phone was behind — Engineer", exact: true })).toBeVisible({ timeout: 40_000 })
    expect(new URL(phone.url()).pathname).toBe(originalBoardPath)
    await expect(source.getByRole("button", { name: "Open New saved on disconnected phone — Engineer", exact: true })).toBeVisible({ timeout: 40_000 })
    await addJobSearchLead(source, "Fresh card after reconnect")
    await expect(phone.getByRole("button", { name: "Open Fresh card after reconnect — Engineer", exact: true })).toBeVisible({ timeout: 30_000 })
    await phone.screenshot({ path: testInfo.outputPath("phone-caught-up.png") })
    await phone.getByRole("button", { name: "Open workspaces", exact: true }).click()
    await phone.getByRole("button", { name: /^Phone retained board.*Owner:/u }).click()
    await expect(phone.getByRole("button", { name: "Open Phone local card — Engineer", exact: true })).toBeVisible()
  } finally {
    await source.goto("about:blank")
    await phoneContext.close()
  }
})
