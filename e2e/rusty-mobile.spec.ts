import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"
import { startIdentityRustyService } from "./support/rustyService"

const identityOrigin = process.env.IDENTITY_E2E_ORIGIN

async function localIdentityWorkspaceState(page: import("@playwright/test").Page) {
  return page.evaluate(async () => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const profile = await bootstrapIdentity()
    const root = await defaultStorage.loadPersonalRoot()
    return {
      personId: profile.identity.personId,
      identityPublicKey: profile.identity.publicKey,
      deviceId: profile.device.deviceId,
      devicePublicKey: profile.device.publicKey,
      certificateSignature: profile.certificate.signature,
      rootId: root?.rootId,
      workspaceReferences: root?.workspaces ?? {},
    }
  })
}

test("Given a portal-enrolled phone, when desktop refreshes and publishes the Identity photo, then phone keeps Rusty and receives it", async ({ page, playwright, baseURL }, info) => {
  test.setTimeout(180_000)
  if (!identityOrigin) throw new Error("Set IDENTITY_E2E_ORIGIN to the pinned local Identity E2E server")
  const portal = await page.context().newPage()
  const browser = await (process.platform === "darwin" ? playwright.webkit : playwright.chromium).launch()
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const phone = await phoneContext.newPage()
  page.setDefaultTimeout(30_000)
  portal.setDefaultTimeout(30_000)
  phone.setDefaultTimeout(30_000)
  const rusty = await startIdentityRustyService(baseURL!)
  const appOrigin = new URL(baseURL!).origin

  try {
    // Create the real manager identity before creating any app-local board state.
    await portal.goto(identityOrigin)
    await portal.getByRole("button", { name: "Create identity", exact: true }).click()
    await portal.locator('#create-form input[name="displayName"]').fill("Rusty Mobile Owner")
    await portal.locator("#create-form").getByRole("button", { name: "Create identity", exact: true }).click()
    await portal.getByRole("heading", { name: "Save your recovery" }).waitFor()
    const backup = portal.waitForEvent("download")
    await portal.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
    await backup
    await portal.locator('input[name="saved-words"]').check()
    await portal.getByRole("button", { name: "Continue to identity", exact: true }).click()
    await portal.getByRole("heading", { name: "Rusty Mobile Owner", exact: true }).waitFor()
    const ownerId = await portal.locator(".identity-id-badge").getAttribute("data-identity-id")
    expect(ownerId).toBeTruthy()

    // Sign the desktop app in as a normal app device; the portal retains owner authority.
    await page.goto("/")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
    await page.getByLabel("Allow this app to use the Identity shown above.").check()
    await page.getByRole("button", { name: "Approve app device", exact: true }).click()
    await page.waitForURL(url => url.origin === appOrigin && url.pathname === "/identity/return", { timeout: 30_000 })
    const replacement = page.getByRole("dialog", { name: "Identity profile", exact: true })
    const replaceConsent = replacement.getByLabel("I understand this changes the active Identity and may leave local boards inaccessible.")
    await expect.poll(async () => await replaceConsent.isVisible().catch(() => false) || await page.evaluate(async id =>
      (await import("/src/domain/identity.ts")).bootstrapIdentity().then(profile => profile.identity.personId === id), ownerId), { timeout: 30_000 }).toBe(true)
    if (await replaceConsent.isVisible().catch(() => false)) {
      await replaceConsent.check()
      await replacement.getByRole("button", { name: "Continue with this Identity", exact: true }).click()
    }
    await expect.poll(async () => page.evaluate(async () =>
      (await import("/src/domain/identity.ts")).bootstrapIdentity().then(profile => profile.identity.personId)), { timeout: 30_000 }).toBe(ownerId)
    await ensureJobSearchWorkspace(page)

    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const host = page.getByRole("dialog", { name: "Device sync" })
    const panel = page.getByRole("region", { name: "Rusty", exact: true })
    await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await panel.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
    await page.getByLabel("Allow this app device and add the listed verified Rusty service keys to the shared Identity catalog.").check()
    await page.getByRole("button", { name: "Approve device and link services", exact: true }).click()
    await page.waitForURL(url => url.origin === appOrigin && url.pathname !== "/identity/return", { timeout: 30_000 })
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })

    // The owner portal issues a genuine Identity enrollment for the phone. App devices
    // cannot mint another manager device through Rusty's old peer-pairing shortcut.
    await portal.getByRole("tab", { name: "Devices", exact: true }).click()
    await portal.getByRole("button", { name: "Add a device", exact: true }).click()
    const invite = portal.getByRole("link", { name: "Open invite link", exact: true })
    await invite.waitFor({ state: "visible", timeout: 30_000 })
    const inviteUrl = await invite.getAttribute("href")
    expect(inviteUrl).toContain("kind=device-enrollment")
    await phone.goto(inviteUrl!)
    const connect = phone.locator("section.dialog.ui-stack").filter({ has: phone.getByRole("heading", { name: "Connect this device", exact: true }) })
    await connect.getByRole("button", { name: "Request connection", exact: true }).click()
    const review = portal.locator("section.dialog.ui-stack").filter({ has: portal.getByRole("heading", { name: "Review device request", exact: true }) })
    await review.waitFor({ state: "visible", timeout: 30_000 })
    await expect(review.locator('input[name="recovery-transfer"]')).not.toBeChecked()
    await review.getByRole("button", { name: "Approve device", exact: true }).click()
    await expect(phone.getByRole("heading", { name: "Rusty Mobile Owner", exact: true })).toBeVisible({ timeout: 30_000 })

    // Sign the approved phone into Tincanban normally. Acceptance imports the current
    // signed Identity profile/catalog, including the desktop's verified Rusty pin.
    await phone.goto(baseURL!)
    await phone.getByRole("button", { name: "Menu", exact: true }).click()
    await phone.getByRole("dialog", { name: "Navigation menu" }).getByRole("button", { name: "Sign in", exact: true }).click()
    await phone.getByRole("heading", { name: "Authorize app device" }).waitFor()
    await phone.getByLabel("Allow this app to use the Identity shown above.").check()
    await phone.getByRole("button", { name: "Approve app device", exact: true }).click()
    await phone.waitForURL(url => url.origin === appOrigin && url.pathname === "/identity/return", { timeout: 30_000 })
    const phoneReplacement = phone.getByRole("dialog", { name: "Identity profile", exact: true })
    const phoneConsent = phoneReplacement.getByLabel("I understand this changes the active Identity and may leave local boards inaccessible.")
    await expect.poll(async () => await phoneConsent.isVisible().catch(() => false) || await phone.evaluate(async id =>
      (await import("/src/domain/identity.ts")).bootstrapIdentity().then(profile => profile.identity.personId === id), ownerId), { timeout: 30_000 }).toBe(true)
    if (await phoneConsent.isVisible().catch(() => false)) {
      await phoneConsent.check()
      await phoneReplacement.getByRole("button", { name: "Continue with this Identity", exact: true }).click()
    }
    await expect.poll(async () => phone.evaluate(async () =>
      (await import("/src/domain/identity.ts")).bootstrapIdentity().then(profile => profile.identity.personId)), { timeout: 30_000 }).toBe(ownerId)
    // Identity sign-in does not join or create a board. Give the phone a real
    // local workspace before testing that the bootstrap preserves its state.
    await ensureJobSearchWorkspace(phone)
    const phoneBeforeBootstrap = await localIdentityWorkspaceState(phone)
    expect(Object.keys(phoneBeforeBootstrap.workspaceReferences).length).toBeGreaterThan(0)

    // Add my device reuses the phone's already-authorized Identity key. It transfers
    // only this active workspace and its existing Rusty storage access.
    await host.getByRole("button", { name: "Add my device", exact: true }).click()
    const deviceInviteUrl = await host.getByLabel("Pairing link").inputValue()
    await phone.goto(deviceInviteUrl)
    const join = phone.getByRole("dialog", { name: "Device sync" })
    await join.getByRole("button", { name: "Add this device", exact: true }).click()
    await expect(host.getByRole("button", { name: "Approve device", exact: true })).toBeVisible({ timeout: 30_000 })
    expect(await host.locator(".auth-code").innerText()).toBe(await join.locator(".auth-code").innerText())
    await host.getByRole("button", { name: "Approve device", exact: true }).click()
    await expect(join.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(host.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30_000 })
    const phoneAfterBootstrap = await localIdentityWorkspaceState(phone)
    expect(phoneAfterBootstrap.personId).toBe(phoneBeforeBootstrap.personId)
    expect(phoneAfterBootstrap.identityPublicKey).toBe(phoneBeforeBootstrap.identityPublicKey)
    expect(phoneAfterBootstrap.deviceId).toBe(phoneBeforeBootstrap.deviceId)
    expect(phoneAfterBootstrap.devicePublicKey).toBe(phoneBeforeBootstrap.devicePublicKey)
    expect(phoneAfterBootstrap.certificateSignature).toBe(phoneBeforeBootstrap.certificateSignature)
    expect(phoneAfterBootstrap.rootId).toBe(phoneBeforeBootstrap.rootId)
    for (const [workspaceId, reference] of Object.entries(phoneBeforeBootstrap.workspaceReferences)) {
      expect(phoneAfterBootstrap.workspaceReferences[workspaceId]).toEqual(reference)
    }
    await join.getByRole("button", { name: "Close", exact: true }).click()
    await host.getByRole("button", { name: "Close", exact: true }).click()
    await phone.getByRole("button", { name: "Menu", exact: true }).click()
    await phone.getByRole("button", { name: "Sync", exact: true }).click()
    const phonePanel = phone.getByRole("region", { name: "Rusty", exact: true })
    await expect(phonePanel.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })

    // A restart keeps the selected workspace and its imported Rusty credentials usable.
    await phone.reload()
    await expect(phone.getByRole("heading", { name: "TINCANBAN Job search", exact: true })).toBeVisible({ timeout: 30_000 })
    await phone.getByRole("button", { name: "Menu", exact: true }).click()
    await phone.getByRole("button", { name: "Sync", exact: true }).click()
    const restartedPanel = phone.getByRole("region", { name: "Rusty", exact: true })
    await expect(restartedPanel.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
    const phoneAfterIdentitySync = await localIdentityWorkspaceState(phone)
    expect(phoneAfterIdentitySync.personId).toBe(phoneBeforeBootstrap.personId)
    expect(phoneAfterIdentitySync.identityPublicKey).toBe(phoneBeforeBootstrap.identityPublicKey)
    expect(phoneAfterIdentitySync.deviceId).toBe(phoneBeforeBootstrap.deviceId)
    expect(phoneAfterIdentitySync.devicePublicKey).toBe(phoneBeforeBootstrap.devicePublicKey)
    expect(phoneAfterIdentitySync.certificateSignature).toBe(phoneBeforeBootstrap.certificateSignature)
    expect(phoneAfterIdentitySync.rootId).toBe(phoneBeforeBootstrap.rootId)
    for (const [workspaceId, reference] of Object.entries(phoneBeforeBootstrap.workspaceReferences)) {
      expect(phoneAfterIdentitySync.workspaceReferences[workspaceId]).toEqual(reference)
    }

    // Phone goes offline while the manager edits the Identity photo.
    await phone.goto("about:blank")
    await portal.goto(`${identityOrigin}/profile`)
    await portal.getByRole("button", { name: "Edit profile", exact: true }).click()
    const image = await portal.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = canvas.height = 128
      const drawing = canvas.getContext("2d")!
      drawing.fillStyle = "#d34630"
      drawing.fillRect(0, 0, 128, 128)
      return canvas.toDataURL("image/png").split(",")[1]!
    })
    await portal.getByLabel("Change avatar", { exact: true }).setInputFiles({
      name: "portrait.png", mimeType: "image/png", buffer: Buffer.from(image, "base64"),
    })
    await portal.getByRole("button", { name: "Save changes", exact: true }).click()
    const source = await portal.locator(".identity-profile-card img").getAttribute("src")
    expect(source).toBeTruthy()

    // TCB refreshes the newly signed portal profile, then publishes that accepted
    // profile state through its pinned Rusty Identity scope before going offline.
    await page.goto(baseURL!)
    await page.getByRole("button", { name: "Open workspaces", exact: true }).waitFor({ state: "visible" })
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const desktopProfile = page.getByRole("region", { name: "Your profile", exact: true })
    await desktopProfile.getByRole("button", { name: "Refresh profile", exact: true }).click()
    await page.waitForURL(url => url.origin === identityOrigin && url.pathname.includes("authorize"), { timeout: 30_000 })
    await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
    await page.getByLabel("Allow this app to use the Identity shown above.").check()
    await page.getByRole("button", { name: "Approve app device", exact: true }).click()
    await page.waitForURL(url => url.origin === appOrigin && url.pathname === "/identity/return", { timeout: 30_000 })
    const desktopReplacement = page.getByRole("dialog", { name: "Identity profile", exact: true })
    const desktopConsent = desktopReplacement.getByLabel("I understand this changes the active Identity and may leave local boards inaccessible.")
    await expect.poll(async () => await desktopConsent.isVisible().catch(() => false) || await page.evaluate(async id =>
      (await import("/src/domain/identity.ts")).bootstrapIdentity().then(profile => profile.identity.personId === id), ownerId), { timeout: 30_000 }).toBe(true)
    if (await desktopConsent.isVisible().catch(() => false)) {
      await desktopConsent.check()
      await desktopReplacement.getByRole("button", { name: "Continue with this Identity", exact: true }).click()
    }
    await expect.poll(async () => page.evaluate(async () =>
      (await import("/src/domain/identity.ts")).bootstrapIdentity().then(profile => profile.identity.personId)), { timeout: 30_000 }).toBe(ownerId)
    await expect.poll(async () => page.evaluate(async () =>
      (await import("/src/storage.ts")).defaultStorage.loadPersonalRoot().then(root => root?.photo?.avatarData ?? null)),
    { timeout: 30_000 }).toBe(source)
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await expect(page.getByRole("region", { name: "Your profile", exact: true }).locator(".connected-profile-photo"))
      .toHaveAttribute("src", source!, { timeout: 30_000 })
    await page.getByRole("button", { name: "Dismiss", exact: true }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const desktopRusty = page.getByRole("region", { name: "Rusty", exact: true })
    await desktopRusty.getByRole("button", { name: "Sync now", exact: true }).click()
    await expect(desktopRusty.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await page.goto("about:blank")

    await phone.goto(baseURL!)
    await phone.getByRole("button", { name: "Menu", exact: true }).click()
    await phone.getByRole("button", { name: "Sync", exact: true }).click()
    await phonePanel.getByRole("button", { name: "Sync now", exact: true }).click()
    await expect(phone.locator(".mesh-member .participant-avatar-photo")).toHaveAttribute("src", source!, { timeout: 30_000 })
    await phone.screenshot({ path: info.outputPath("rusty-and-photo-on-phone.png") })
  } finally {
    await phoneContext.close()
    await browser.close()
    await portal.close()
    await rusty.close()
  }
})
