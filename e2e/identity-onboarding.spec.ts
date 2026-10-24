import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test.use({ trace: "off", video: "off", screenshot: "off" })
const identityOrigin = process.env.IDENTITY_E2E_ORIGIN ?? ""

function sanitizeUiDiagnostics(values: string[]): string[] {
  return values.map(value => value.replace(/https?:\/\/\S+/gu, "<url>")
    .replace(/\b[a-f0-9]{32,}\b/giu, "<identifier>")
    .replace(/\b(?:[a-z]{3,}\s+){11}[a-z]{3,}\b/giu, "<recovery-words>").slice(0, 240))
}

async function clearIdentityInvitations(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input[type=url], input[readonly], textarea")
      .forEach(input => { input.value = "" })
  }).catch(() => undefined)
}

test("Given a pending Identity invitation, when device connection is cancelled, then keep the guest profile and stop enrollment", async ({ page }) => {
  test.skip(!identityOrigin, "Set IDENTITY_E2E_ORIGIN to a running Identity portal")
  const browserErrors: string[] = []
  page.on("pageerror", error => browserErrors.push(error.stack ?? error.message))
  page.on("console", message => { if (message.type() === "error") browserErrors.push(message.text()) })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  const before = await page.evaluate(async (portalOrigin: string) => {
    const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
    const controller = new AbortController()
    let inviteUrl = ""
    let hostError = ""
    const host = (await import("/src/app/identityPortalEnrollment.ts")).startIdentityProfileHost({
      profile, portalOrigin, signal: controller.signal,
      onInvite: invite => { inviteUrl = invite }, onStatus: () => {},
      onRequest: () => new Promise<"approve" | "reject">(resolve => controller.signal.addEventListener("abort", () => resolve("reject"), { once: true })),
    })
    void host.catch(error => { hostError = error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
    ;(window as unknown as { onboardingHost: { controller: AbortController; host: Promise<unknown>; invite(): string; error(): string } }).onboardingHost = {
      controller, host, invite: () => inviteUrl, error: () => hostError,
    }
    const deadline = Date.now() + 10000
    while (!inviteUrl && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    return { personId: profile.identity.personId, inviteUrl, hostError }
  }, identityOrigin)
  try {
    expect(before.inviteUrl, `${before.hostError}\n${browserErrors.join("\n")}`).toContain("#")
    await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: "Add another device", exact: true }).click()
    const dialog = page.getByRole("dialog", { name: "Identity profile", exact: true })
    await dialog.getByLabel("Identity invitation").fill(before.inviteUrl)
    await dialog.getByRole("button", { name: "Connect this device", exact: true }).click()
    await expect(dialog.getByRole("status")).toContainText("Connecting", { timeout: 15000 })
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(dialog.getByRole("button", { name: "Connect this device", exact: true })).toBeEnabled({ timeout: 10000 })
    const after = await page.evaluate(async () => ({
      personId: (await (await import("/src/domain/identity.ts")).bootstrapIdentity()).identity.personId,
    }))
    expect(after.personId).toBe(before.personId)
  } finally {
    await page.evaluate(() => {
      const host = (window as unknown as { onboardingHost: { controller: AbortController } }).onboardingHost
      host.controller.abort()
    }).catch(() => {})
    await page.evaluate(async () => {
      await (window as unknown as { onboardingHost: { host: Promise<unknown> } }).onboardingHost.host.catch(() => undefined)
    }).catch(() => {})
    await clearIdentityInvitations(page)
  }
})

test("Given an invalid Identity invitation, when connecting, then show an error and keep local Identity", async ({ page }) => {
  test.skip(!identityOrigin, "Set IDENTITY_E2E_ORIGIN to a running Identity portal")
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
  const personId = await page.evaluate(async () => (await (await import("/src/domain/identity.ts")).bootstrapIdentity()).identity.personId)
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: "Add another device", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Identity profile", exact: true })
  await dialog.getByLabel("Identity invitation").fill("not-an-identity-invitation")
  await dialog.getByRole("button", { name: "Connect this device", exact: true }).click()
  await expect(dialog.getByRole("alert")).toContainText(/invalid/i)
  expect(await page.evaluate(async () => (await (await import("/src/domain/identity.ts")).bootstrapIdentity()).identity.personId)).toBe(personId)

  await dialog.getByRole("button", { name: "Close", description: "Close window" }).click()
  await ensureJobSearchWorkspace(page)
  await page.context().setOffline(true)
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  const add = page.getByRole("dialog", { name: "Add item" })
  await add.getByLabel("Company *").fill("Offline portal board")
  await add.getByLabel("Role *").fill("Local edit")
  await add.getByRole("button", { name: "Create item" }).click()
  await expect(page.getByRole("button", { name: "Open Offline portal board — Local edit", exact: true })).toBeVisible()
  const detail = page.getByRole("dialog", { name: "Item overview" })
  await detail.getByRole("button", { name: "Edit" }).click()
  const edit = page.getByRole("dialog", { name: "Edit item" })
  await edit.getByLabel("Role *").fill("Edited while portal is offline")
  await edit.getByRole("button", { name: "Save changes" }).click()
  await expect(detail).toContainText("Edited while portal is offline")
})

test("Given an unregistered local profile, when Add my device requests registration, then enroll same person, save recovery, and resume the device action", async ({ browser, page }) => {
  test.skip(!identityOrigin, "Set IDENTITY_E2E_ORIGIN to a running Identity portal")
  test.setTimeout(90_000)
  const portalContext = await browser.newContext()
  const portal = await portalContext.newPage()
  let stage = "start"
  const mark = (next: string) => { stage = next; console.info(`[identity-onboarding] ${next}`) }
  const enrollmentDiagnostics: Array<{ side: string; streamPhase: string; frameKind: string; encryptedByteLength: number | null }> = []
  const browserFaults: Array<{ side: string; name: string; frames: string[] }> = []
  const captureEnrollmentDiagnostics = (target: typeof page, side: string) => target.on("console", async message => {
    if (message.type() !== "warning" || !message.text().includes("Identity enrollment frame failed")) return
    const args = message.args()
    const details = args.length > 1 ? await args[1].jsonValue().catch(() => undefined) : undefined
    if (!details || typeof details !== "object") return
    const value = details as Record<string, unknown>
    enrollmentDiagnostics.push({ side,
      streamPhase: typeof value.streamPhase === "string" ? value.streamPhase : "unknown",
      frameKind: typeof value.frameKind === "string" ? value.frameKind : "unknown",
      encryptedByteLength: typeof value.encryptedByteLength === "number" ? value.encryptedByteLength : null,
    })
  })
  const captureBrowserFaults = (target: typeof page, side: string) => target.on("pageerror", error => {
    const frames = (error.stack ?? "").split("\n").slice(1, 5)
      .map(frame => frame.replace(/https?:\/\/[^/\s)]+/gu, "<origin>").replace(/[?#][^\s)]*/gu, ""))
    browserFaults.push({ side, name: error.name, frames })
  })
  captureEnrollmentDiagnostics(page, "tincanban")
  captureEnrollmentDiagnostics(portal, "identity")
  captureBrowserFaults(page, "tincanban")
  captureBrowserFaults(portal, "identity")
  try {
    mark("open Tincanban")
    await page.goto("/")
    mark("wait for local workspace")
    await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30000 })
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const sync = page.getByRole("dialog", { name: "Device sync" })
    mark("open add-device registration")
    await sync.getByRole("button", { name: "Add my device", exact: true }).click()

    const enrollment = page.getByRole("dialog", { name: "Identity profile", exact: true })
    mark("create Identity invitation")
    await enrollment.getByRole("button", { name: "Create profile", exact: true }).click()
    const invitation = enrollment.getByLabel("Identity invitation")
    await expect.poll(async () => (await invitation.inputValue()).includes("#"), { timeout: 30000 }).toBe(true)
    const inviteUrl = await invitation.inputValue()

    mark("open Identity portal")
    await portal.goto(inviteUrl)
    const connect = portal.locator("#connect-device-form")
    await expect(portal.getByRole("heading", { name: "Connect this device", exact: true })).toBeVisible()
    await connect.locator('input[name="deviceLabel"]').fill("Tincanban test device")
    const guestRecoveryConsent = connect.locator('input[name="accept-recovery"]')
    await guestRecoveryConsent.check()
    expect(await guestRecoveryConsent.isChecked()).toBe(true)
    expect(await connect.evaluate(form => (form as HTMLFormElement).checkValidity())).toBe(true)
    mark("request Identity approval")
    await connect.getByRole("button", { name: "Request connection", exact: true }).click()
    await expect(portal.getByRole("status")).toContainText("Waiting for approval from the trusted Identity device", { timeout: 30000 })

    mark("approve matching device")
    const approval = enrollment.getByRole("region", { name: "Device approval" })
    await expect(approval).toContainText("Identity person:", { timeout: 30000 })
    await expect(approval).toContainText("Guest signed consent for full recovery transfer: Yes.")
    const identityLine = await approval.locator("p").filter({ hasText: "Identity person:" }).textContent()
    const localPersonId = identityLine?.replace(/^.*?Identity person:\s*/u, "").trim()
    if (!localPersonId) throw new Error("Could not read the verified Identity enrollment request")
    await expect(approval).toContainText(localPersonId)
    const ownerRecoveryConsent = approval.getByLabel("I approve transferring full Identity recovery for this person.")
    await ownerRecoveryConsent.check()
    expect(await ownerRecoveryConsent.isChecked()).toBe(true)
    await expect(approval.getByRole("button", { name: "Approve and create profile", exact: true })).toBeEnabled()
    await approval.getByRole("button", { name: "Approve and create profile", exact: true }).click()

    const backup = portal.locator("section.dialog.ui-stack").filter({
      has: portal.getByRole("heading", { name: "Save recovery before connecting", exact: true }),
    })
    mark("wait for recovery offer")
    try { await expect(backup).toBeVisible({ timeout: 30000 }) }
    catch {
      const portalAlert = await portal.getByRole("alert").allTextContents().catch(() => [])
      const portalStatus = await portal.getByRole("status").allTextContents().catch(() => [])
      const hostAlert = await enrollment.getByRole("alert").allTextContents().catch(() => [])
      const hostStatus = await enrollment.getByRole("status").allTextContents().catch(() => [])
      throw new Error(`Enrollment stopped at ${stage}; portalAlert=${JSON.stringify(sanitizeUiDiagnostics(portalAlert))}; portalStatus=${JSON.stringify(sanitizeUiDiagnostics(portalStatus))}; hostAlert=${JSON.stringify(sanitizeUiDiagnostics(hostAlert))}; hostStatus=${JSON.stringify(sanitizeUiDiagnostics(hostStatus))}; signedGuestConsent=Yes; ownerConsent=checked; diagnostics=${JSON.stringify(enrollmentDiagnostics)}; browserFaults=${JSON.stringify(browserFaults)}`)
    }
    await expect(backup.locator(".identity-words li")).toHaveCount(12)
    const fileDownload = portal.waitForEvent("download")
    await backup.getByRole("button", { name: "Download encrypted file", exact: true }).click()
    const downloaded = await fileDownload
    expect(downloaded.suggestedFilename()).toMatch(/identity-recovery-.*\.identity\.json/u)
    await backup.getByLabel("I saved these recovery words somewhere safe.").check()
    mark("acknowledge recovery backup")
    await backup.getByRole("button", { name: "Confirm and connect", exact: true }).click()

    mark("verify registration and resume action")
    await expect(portal.locator(".identity-id-badge")).toHaveAttribute("data-identity-id", localPersonId, { timeout: 60000 })
    await expect(enrollment).not.toBeVisible({ timeout: 60000 })
    await expect(sync.getByText("Add your second device", { exact: true })).toBeVisible({ timeout: 60000 })
    await expect(sync.getByRole("button", { name: "Copy enrollment link", exact: true })).toBeVisible()
    await expect(sync.getByRole("button", { name: "Copy enrollment link", exact: true })).toBeEnabled()
    expect(browserFaults, JSON.stringify(browserFaults)).toEqual([])
  } finally {
    console.info(`[identity-onboarding] cleanup after ${stage}`)
    const cleanupPages = Promise.all([clearIdentityInvitations(page), clearIdentityInvitations(portal)])
    await Promise.race([cleanupPages, new Promise(resolve => setTimeout(resolve, 2000))])
    await Promise.race([portalContext.close(), new Promise(resolve => setTimeout(resolve, 5000))])
  }
})
