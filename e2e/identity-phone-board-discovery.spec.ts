import { expect, test, type BrowserContext, type Page } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"
import { startIdentityRustyService } from "./support/rustyService"

type Attribute = { key: string; value: Record<string, unknown> }
type LogRecord = { body?: { stringValue?: string }; attributes?: Attribute[]; traceId?: string }
type Span = { name?: string; traceId?: string; spanId?: string; parentSpanId?: string;
  events?: Array<{ name?: string; attributes?: Attribute[] }> }
type OtlpLogs = { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: LogRecord[] }> }> }
type OtlpTraces = { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Span[] }> }> }

const identityOrigin = process.env.IDENTITY_E2E_ORIGIN
const avatarPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nWQAAAAASUVORK5CYII=",
  "base64",
)

test.skip(!identityOrigin, "Set IDENTITY_E2E_ORIGIN to an isolated Identity portal preview")
test.use({ video: "off", screenshot: "off" })

async function createOwnerIdentity(portal: Page): Promise<string> {
  await portal.goto(identityOrigin!)
  await portal.getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.getByLabel("Display name").fill("Bo catalog owner")
  await portal.locator("#create-form button").click()
  await expect(portal).toHaveURL(/\/create\/backup$/u)
  const download = portal.waitForEvent("download")
  await portal.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
  await download
  await portal.getByLabel("I saved these recovery words somewhere safe.").check()
  await portal.getByRole("button", { name: "Continue to identity", exact: true }).click()
  await expect(portal).toHaveURL(/\/profile$/u)
  await portal.getByRole("button", { name: "Edit profile", exact: true }).click()
  await portal.getByLabel("Change avatar").setInputFiles({ name: "bo-avatar.png", mimeType: "image/png", buffer: avatarPng })
  await portal.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(portal.locator(".identity-profile-card .identity-avatar img")).toHaveAttribute("src", /^data:image\/webp;base64,/u)
  return (await portal.locator(".identity-id-badge").getAttribute("data-identity-id"))!
}

async function approveApplicationDevice(page: Page, appOrigin: string, personId: string, localBoardChoice?: "add" | "stay"): Promise<void> {
  await page.addInitScript(({ expectedOrigin }) => {
    if (location.origin !== expectedOrigin || location.pathname !== "/identity/return") return
    const pendingKey = "tincanban.identity-browser-signin.pending.v1"
    const pendingRaw = sessionStorage.getItem(pendingKey)
    let pendingChallenge: string | undefined
    try { pendingChallenge = (JSON.parse(pendingRaw ?? "null") as { request?: { payload?: { challenge?: string } } } | null)?.request?.payload?.challenge }
    catch { /* Keep only a boolean diagnostic. */ }
    const state = new URLSearchParams(location.hash.slice(1)).get("state")
    sessionStorage.setItem("tincanban.e2e.identity-callback-check", JSON.stringify({
      pendingPresent: pendingRaw !== null, statePresent: Boolean(state), challengeMatches: Boolean(state && pendingChallenge === state),
    }))
  }, { expectedOrigin: appOrigin })
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`^${identityOrigin!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/authorize#`), { timeout: 30_000 })
  await expect(page.getByRole("heading", { name: "Authorize app device", exact: true })).toBeVisible()
  await page.getByLabel("Allow this app to use the Identity shown above.", { exact: true }).check()
  await page.getByRole("button", { name: "Approve app device", exact: true }).click()
  if (localBoardChoice) {
    await expect(page.getByRole("heading", { name: /Add your local boards to/u })).toBeVisible({ timeout: 30_000 })
    await page.getByRole("button", { name: localBoardChoice === "add" ? "Add boards and sign in" : "Stay on my boards", exact: true }).click()
    if (localBoardChoice === "stay") {
      await expect(page.getByText("Stayed on your boards. Sign-in was not completed.", { exact: true })).toBeVisible()
      await page.getByRole("dialog", { name: "Identity profile", exact: true }).getByText("Close", { exact: true }).click()
      return
    }
  }
  try {
    await page.waitForFunction(origin => location.origin === origin &&
      (location.pathname !== "/identity/return" || Boolean(document.querySelector('[role="alert"]'))), appOrigin, { timeout: 30_000 })
  } catch {
    const snapshot = await page.evaluate(async () => {
      const telemetry = await import("/src/sync/telemetry.ts")
      await telemetry.retryTelemetry()
      const app = (await import("/src/state.ts")).useTincanban()
      return { callbackPending: location.pathname === "/identity/return", title: app.activeWorkspace.title,
        alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent?.slice(0, 500)),
        locks: navigator.locks ? await navigator.locks.query().then(value => ({
          held: value.held?.map(lock => lock.name?.split(":")[0]), pending: value.pending?.map(lock => lock.name?.split(":")[0]),
        })) : null }
    })
    throw new Error(`Identity callback did not finish: ${JSON.stringify(snapshot)}`)
  }
  const callbackAlert = await page.getByRole("alert").allTextContents()
  if (callbackAlert.length) throw new Error(`Identity callback rejected: ${callbackAlert.join("; ")}`)
  const callbackCheck = await page.evaluate(() => {
    try { return JSON.parse(sessionStorage.getItem("tincanban.e2e.identity-callback-check") ?? "null") }
    catch { return null }
  })
  expect(callbackCheck).toEqual({ pendingPresent: true, statePresent: true, challengeMatches: true })
  await expect.poll(() => page.evaluate(async () =>
    (await import("/src/state.ts")).useTincanban().getCurrentProfile()?.identity.personId ?? null), { timeout: 45_000 }).toBe(personId)
  await expect(page.getByRole("dialog", { name: "Identity profile", exact: true })).toBeHidden()
}

async function joinAsEditor(owner: Page, peer: Page): Promise<void> {
  await owner.getByRole("button", { name: "Sync", exact: true }).click()
  const host = owner.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone", exact: true }).click()
  await host.getByRole("button", { name: "Generate link", exact: true }).click()
  await peer.goto(await host.getByLabel("Pairing link").inputValue())
  const joining = peer.getByRole("dialog", { name: "Device sync" })
  await joining.getByRole("button", { name: "Accept and join", exact: true }).click()
  await expect(host.getByLabel("Participant role")).toBeVisible({ timeout: 30_000 })
  await host.getByLabel("Participant role").selectOption("editor")
  await host.getByRole("button", { name: "Approve access", exact: true }).click()
  await expect(joining.getByText(/Connected to/)).toBeVisible({ timeout: 40_000 })
  await joining.getByRole("button", { name: "Close", exact: true }).click()
  await host.getByRole("button", { name: "Close", exact: true }).click()
}

async function enrollPhoneManager(ownerPortal: Page, phonePortal: Page, personId: string): Promise<void> {
  await ownerPortal.getByRole("tab", { name: "Devices", exact: true }).click()
  await ownerPortal.getByRole("button", { name: "Manage devices", exact: true }).click()
  await expect(ownerPortal).toHaveURL(/\/devices$/u)
  await ownerPortal.getByRole("button", { name: "Add a device", exact: true }).click()
  await expect(ownerPortal).toHaveURL(/\/devices\/add$/u)
  const invite = ownerPortal.getByRole("link", { name: "Open invite link", exact: true })
  await expect(invite).toBeVisible({ timeout: 45_000 })
  const inviteUrl = await invite.getAttribute("href")
  if (!inviteUrl) throw new Error("Identity did not create a device invitation")

  await phonePortal.goto(inviteUrl)
  await expect(phonePortal.getByRole("heading", { name: "Connect this device", exact: true })).toBeVisible()
  await phonePortal.getByRole("button", { name: "Request connection", exact: true }).click()
  const review = ownerPortal.locator("section.dialog.ui-stack").filter({
    has: ownerPortal.getByRole("heading", { name: "Review device request", exact: true }),
  })
  await expect(review).toBeVisible({ timeout: 45_000 })
  await expect(review.locator('input[name="recovery-transfer"]')).not.toBeChecked()
  await review.getByRole("button", { name: "Approve device", exact: true }).click()
  await expect(phonePortal.getByRole("heading", { name: "Bo catalog owner", exact: true })).toBeVisible({ timeout: 45_000 })
  await expect(phonePortal.locator(".identity-id-badge")).toHaveAttribute("data-identity-id", personId)
  const rootKeyIsAbsent = await phonePortal.evaluate(async () => {
    const raw = localStorage.getItem("meta-mesh.identity.profile.v1")
    if (!raw) return false
    const saved = JSON.parse(raw) as { identity?: unknown; privateKeys?: { identityPrivateKeyPkcs8?: unknown; devicePrivateKeyPkcs8?: unknown } }
    return Boolean(saved.identity && saved.privateKeys?.devicePrivateKeyPkcs8 &&
      saved.privateKeys.identityPrivateKeyPkcs8 === undefined)
  })
  expect(rootKeyIsAbsent).toBe(true)
}

async function connectRusty(page: Page, rustyOrigin: string): Promise<void> {
  const appOrigin = new URL(page.url()).origin
  const traffic: string[] = []
  const rustyOriginValue = new URL(rustyOrigin).origin
  const safePath = (input: string) => {
    const url = new URL(input)
    return url.pathname.replace(/[A-Za-z0-9_-]{40,}/gu, "<id>")
  }
  page.on("request", request => {
    if (new URL(request.url()).origin === rustyOriginValue) traffic.push(`${request.method()} ${safePath(request.url())}`)
  })
  page.on("response", response => {
    if (new URL(response.url()).origin === rustyOriginValue) traffic.push(`${response.status()} ${safePath(response.url())}`)
  })
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const rusty = page.getByRole("region", { name: "Rusty", exact: true })
  await rusty.getByRole("button", { name: "Add Rusty", exact: true }).click()
  await rusty.getByLabel("Address", { exact: true }).fill(rustyOrigin)
  await rusty.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Authorize app device", exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByLabel("Allow this app device and add the listed verified Rusty service keys to the shared Identity catalog.").check()
  await page.getByRole("button", { name: "Approve device and link services", exact: true }).click()
  await page.waitForURL(url => url.origin === appOrigin && url.pathname !== "/identity/return", { timeout: 30_000 })
  const visibleOutcome = await page.evaluate(() => [...document.querySelectorAll('[role="alert"], [role="status"]')]
    .map(node => (node.textContent ?? "").trim()).find(text =>
      /Identity linked|Rusty setup|Could not|failed|unavailable/iu.test(text)) ?? null)
  if (visibleOutcome) throw new Error(`Rusty approval returned with visible setup outcome: ${visibleOutcome}; recent requests: ${traffic.slice(-16).join(" | ")}`)
  await expect(page.getByRole("dialog", { name: "Identity profile", exact: true })).toBeHidden({ timeout: 30_000 })
  await expect(page.getByRole("button", { name: "Sync", exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await page.waitForFunction(() => Boolean(document.querySelector(".rusty-connections .rusty-connection")) ||
    [...document.querySelectorAll('[role="alert"], [role="status"]')].some(node =>
      /Identity linked|Rusty setup|Could not|failed|unavailable/iu.test(node.textContent ?? "")), null, { timeout: 30_000 })
  const connectionError = await page.evaluate(() => [...document.querySelectorAll('[role="alert"], [role="status"]')]
    .map(node => (node.textContent ?? "").trim()).find(text =>
      /Identity linked|Rusty setup|Could not|failed|unavailable/iu.test(text)) ?? null)
  if (connectionError) throw new Error(`Rusty setup returned with visible status: ${connectionError}; recent requests: ${traffic.slice(-16).join(" | ")}`)
  await expect(rusty.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
    .toBeVisible({ timeout: 30_000 })
  await rusty.getByRole("button", { name: "Sync now", exact: true }).click()
  const profileStatus = page.locator(".rusty-profile-status")
  await expect(profileStatus).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => {
    const alerts = await profileStatus.locator('[role="alert"]').allTextContents()
    const rows = await profileStatus.locator(".rusty-profile-connection").allTextContents()
    const visibleAlerts = alerts.map(text => text.trim()).filter(Boolean)
    const visibleRows = rows.map(text => text.trim())
    return { terminal: visibleAlerts.length > 0 || visibleRows.some(text => /Synced|Sync paused|Check overdue|not configured|Removal pending/iu.test(text)),
      alerts: visibleAlerts, rows: visibleRows }
  }, { timeout: 30_000 }).toMatchObject({ terminal: true, alerts: [] })
  const delivery = (await profileStatus.locator(".rusty-profile-connection").allTextContents())
    .map(text => text.trim())
  if (!delivery.some(text => text.includes("Synced"))) {
    const configs = await page.evaluate(() => {
      return import("/src/state.ts").then(async ({ useTincanban }) => {
        const app = useTincanban()
        const profile = app.getCurrentProfile()
        const { getIdentityReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
        const identityConfigs = profile ? await getIdentityReplicaConfigurations(profile.identity.personId) : []
        return { identityConfigCount: identityConfigs.length, sourceDeviceIdPresent: Boolean(profile?.device.deviceId),
          configuredOriginCount: new Set(identityConfigs.map(config => config.origin)).size }
      })
    })
    await page.evaluate(async () => (await import("/src/sync/telemetry.ts")).retryTelemetry())
    throw new Error(`Rusty profile delivery did not sync: ${JSON.stringify({ delivery, configKeyCounts: configs, recentRequests: traffic.slice(-16) })}`)
  }
}

function exceptionDetails(spans: Span[]): Array<{ type?: unknown; message?: string; locations: string[] }> {
  return spans.filter(span => span.name === "rusty.sync").flatMap(span => (span.events ?? [])
    .filter(event => event.name === "exception").map(event => {
      const value = (key: string) => event.attributes?.find(attribute => attribute.key === key)?.value
      const rawMessage = value("exception.message")
      const message = typeof rawMessage?.stringValue === "string" ? rawMessage.stringValue.slice(0, 320) : undefined
      const rawStack = value("exception.stacktrace")
      const stack = typeof rawStack?.stringValue === "string" ? rawStack.stringValue : ""
      const locations = stack.split("\n").map(line => line.match(/(?:src|dist|node_modules)\/[^\s():]+:\d+:\d+/u)?.[0])
        .filter((location): location is string => Boolean(location)).slice(0, 8)
      return { type: value("exception.type")?.stringValue, ...(message ? { message } : {}), locations }
    }))
}

async function projectedAvatar(page: Page, workspaceId: string, personId: string): Promise<string | null> {
  return page.evaluate(async ({ workspaceId, personId }) => {
    const app = (await import("/src/state.ts")).useTincanban()
    const { memberProfileEntityId, memberAvatarData } = await import("/src/domain/avatarData.ts")
    const entity = app.getActiveDoc()?.entities[memberProfileEntityId(personId)]
    if (app.activeWorkspace.id !== workspaceId || entity?.kind !== "member_profile") return null
    return memberAvatarData(entity.data) ?? null
  }, { workspaceId, personId })
}

async function identityRustyPinOrigins(portal: Page, personId: string): Promise<string[]> {
  return portal.evaluate(personId => {
    const raw = localStorage.getItem(`meta-mesh.identity.profile-state.v1.${personId}`)
    if (!raw) return []
    const state = JSON.parse(raw) as { operations?: Array<{ signed?: { payload?: { field?: unknown; value?: { origin?: unknown } } } }> }
    return (state.operations ?? []).flatMap(operation => {
      const payload = operation.signed?.payload
      return payload?.field === "rustyServicePin" && typeof payload.value?.origin === "string"
        ? [payload.value.origin] : []
    })
  }, personId)
}

test("Given an enrolled phone and untouched local Untitled, when Bo signs in, then current owned board and photo load and edits sync", async ({
  page: desktop, context, browser, baseURL,
}) => {
  test.setTimeout(300_000)
  if (!identityOrigin) throw new Error("Set IDENTITY_E2E_ORIGIN to an isolated Identity portal")
  const appOrigin = new URL(baseURL!).origin
  const ownerPortal = await context.newPage()
  const rusty = await startIdentityRustyService(`${appOrigin},${identityOrigin}`)
  const peerContext: BrowserContext = await browser.newContext()
  const phoneContext: BrowserContext = await browser.newContext()
  const peer = await peerContext.newPage()
  const phone = await phoneContext.newPage()
  const phonePortal = await phoneContext.newPage()
  const phoneLogs: LogRecord[] = []
  const phoneSpans: Span[] = []
  const desktopSpans: Span[] = []
  const browserKey = "public-browser-fixture-key-0123456789"
  await context.route("https://telemetry.invalid/v1/traces", async route => {
    const headers = route.request().headers()
    expect(headers.authorization).toBe(`Bearer ${browserKey}`)
    expect(headers["x-tinsink-project"]).toBe("tincanban")
    expect(headers["x-tinsink-source"]).toBe("browser")
    desktopSpans.push(...traceSpans(route.request().postDataJSON() as OtlpTraces))
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  })
  await phoneContext.route("https://telemetry.invalid/v1/logs", async route => {
    const headers = route.request().headers()
    expect(headers.authorization).toBe(`Bearer ${browserKey}`)
    expect(headers["x-tinsink-project"]).toBe("tincanban")
    expect(headers["x-tinsink-source"]).toBe("browser")
    phoneLogs.push(...logRecords(route.request().postDataJSON() as OtlpLogs))
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  })
  await phoneContext.route("https://telemetry.invalid/v1/traces", async route => {
    phoneSpans.push(...traceSpans(route.request().postDataJSON() as OtlpTraces))
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  })

  try {
    const personId = await createOwnerIdentity(ownerPortal)
    expect(personId).toMatch(/^[A-Za-z0-9_-]{43}$/u)

    // Seed a second authorized Identity manager before publishing this app's
    // board catalog. Phone receives no TCB board/configuration state here.
    await enrollPhoneManager(ownerPortal, phonePortal, personId)
    await phone.goto(baseURL!)
    await expect(phone.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
    const anonymous = await phone.evaluate(async () => {
      const app = (await import("/src/state.ts")).useTincanban()
      const loaded = await app.readWorkspaceDoc(app.activeWorkspace.id)
      return { id: app.activeWorkspace.id, title: loaded.title,
        ownerPersonId: loaded.ownerPersonId, profilePersonId: app.getCurrentProfile()!.identity.personId,
        items: Object.values(loaded.entities).filter(entity => entity.kind === "item").length }
    })
    expect(anonymous).toMatchObject({ title: "Untitled", ownerPersonId: anonymous.profilePersonId, items: 0 })

    await desktop.goto(baseURL!)
    await expect(desktop.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
    await approveApplicationDevice(desktop, appOrigin, personId)
    await createJobSearchWorkspace(desktop, "Bo Job search")
    const actualWorkspaceId = await desktop.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)
    await desktop.getByRole("region", { name: "Lead", exact: true })
      .getByRole("button", { name: "Add lead to Lead", exact: true }).click()
    const create = desktop.getByRole("dialog", { name: "Add item" })
    await create.getByLabel("Company *").fill("Bo private opportunity")
    await create.getByLabel("Role *").fill("Senior engineer")
    await create.getByRole("button", { name: "Create item", exact: true }).click()
    await expect(desktop.getByRole("button", { name: /Open Bo private opportunity/u })).toBeVisible()
    // Service verification may finish after Playwright's default 5s expectation.
    // Hold the real service descriptor to cover the pending navigation boundary.
    let delayedDescriptorRequests = 0
    await desktop.route(`${rusty.origin}/.well-known/mesh-lighthouse`, async route => {
      delayedDescriptorRequests += 1
      const startedAt = performance.now()
      const response = await route.fetch()
      // Include real service latency instead of adding another 6.5s to it.
      const remainingDelay = 6_500 - (performance.now() - startedAt)
      if (remainingDelay > 0) await new Promise(resolve => setTimeout(resolve, remainingDelay))
      await route.fulfill({ response })
    }, { times: 1 })
    try { await connectRusty(desktop, rusty.origin) }
    catch (cause) {
      // A test readiness failure need not create an application exception.
      const message = (cause instanceof Error ? cause.message : "Rusty profile delivery failed")
        .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gu, "$1<redacted>")
      throw new Error(`${message}; captured rusty.sync exceptions: ${JSON.stringify(exceptionDetails(desktopSpans))}`, { cause })
    }
    expect(delayedDescriptorRequests).toBe(1)
    await expect.poll(() => identityRustyPinOrigins(phonePortal, personId), { timeout: 30_000 }).toContain(rusty.origin)
    await joinAsEditor(desktop, peer)

    try { await approveApplicationDevice(phone, appOrigin, personId) }
    catch (cause) {
      const phases = phoneLogs.filter(log => log.body?.stringValue === "identity.browser_signin")
        .map(log => ({ phase: attribute(log, "sync.phase"), outcome: attribute(log, "identity.signin.outcome") }))
      throw new Error(`${cause instanceof Error ? cause.message : "Phone callback failed"}; phases: ${JSON.stringify(phases)}; errors: ${JSON.stringify(exceptionDetails(phoneSpans))}`, { cause })
    }
    try {
      await expect(phone.getByRole("region", { name: "Bo Job search", exact: true })).toBeVisible({ timeout: 60_000 })
    } catch {
      await phone.evaluate(async () => (await import("/src/sync/telemetry.ts")).retryTelemetry())
      const state = await phone.evaluate(async ({ expectedPersonId }) => {
        const app = (await import("/src/state.ts")).useTincanban()
        const profile = app.getCurrentProfile()
        const telemetry = await import("/src/sync/telemetry.ts")
        return { identityMatches: profile?.identity.personId === expectedPersonId,
          activeTitle: app.activeWorkspace?.title ?? null,
          visibleMessages: [...document.querySelectorAll('[role="alert"], [role="status"]')]
            .map(node => (node.textContent ?? "").trim()).filter(Boolean),
          telemetry: telemetry.telemetryStatus() }
      }, { expectedPersonId: personId })
      const signInPhases = phoneLogs.filter(log => log.body?.stringValue === "identity.browser_signin")
        .map(log => ({ phase: attribute(log, "sync.phase"), outcome: attribute(log, "identity.signin.outcome"),
          errorCode: attribute(log, "identity.signin.error_code"), traceId: log.traceId }))
      throw new Error(`Phone board discovery failed: ${JSON.stringify({ ...state, signInPhases })}`)
    }
    await expect(phone.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(phone.getByRole("button", { name: /Open Bo private opportunity/u })).toBeVisible()
    expect(await phone.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id))
      .not.toBe(anonymous.id)
    const profile = await phone.evaluate(async () => {
      const storage = await import("/src/storage.ts")
      return storage.defaultStorage.loadPersonalRoot()
    })
    expect(profile?.identity.personId).toBe(personId)
    expect(profile?.photo?.avatarData).toMatch(/^data:image\/webp;base64,/u)

    await phone.getByRole("button", { name: /Open Bo private opportunity/u }).click()
    const details = phone.getByRole("dialog", { name: "Item overview" })
    await details.getByRole("button", { name: "Edit", exact: true }).click()
    const edit = phone.getByRole("dialog", { name: "Edit item" })
    await edit.getByLabel("Role *").fill("Senior engineer on phone")
    await edit.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect(phone.getByRole("button", { name: /Open Bo private opportunity — Senior engineer on phone/u })).toBeVisible()

    await phone.getByRole("button", { name: "Sync", exact: true }).click()
    const phoneRusty = phone.getByRole("region", { name: "Rusty", exact: true })
    await phoneRusty.getByRole("button", { name: "Sync now", exact: true }).click()
    await desktop.getByRole("button", { name: "Sync", exact: true }).click()
    const desktopRusty = desktop.getByRole("region", { name: "Rusty", exact: true })
    await desktopRusty.getByRole("button", { name: "Sync now", exact: true }).click()
    await expect(desktop.getByRole("button", { name: /Open Bo private opportunity — Senior engineer on phone/u })).toBeVisible({ timeout: 45_000 })
    await expect.poll(() => projectedAvatar(peer, actualWorkspaceId, personId), { timeout: 45_000 })
      .toMatch(/^data:image\/webp;base64,/u)

    await phone.reload()
    await expect(phone.getByRole("region", { name: "Bo Job search", exact: true })).toBeVisible({ timeout: 60_000 })
    await expect(phone.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(phone.getByRole("button", { name: /Open Bo private opportunity — Senior engineer on phone/u })).toBeVisible()
    const restored = await phone.evaluate(async () => {
      const storage = await import("/src/storage.ts")
      const root = await storage.defaultStorage.loadPersonalRoot()
      return { personId: root?.identity.personId, photo: root?.photo?.avatarData }
    })
    expect(restored.personId).toBe(personId)
    expect(restored.photo).toMatch(/^data:image\/webp;base64,/u)

    await phone.evaluate(async () => (await import("/src/sync/telemetry.ts")).retryTelemetry())
    const expectedPhases = [
      ["request", "completed"], ["callback", "verified"], ["adoption", "completed"],
      ["catalog", "completed"], ["boards", "completed"], ["restore", "completed"],
    ] as const
    await expect.poll(() => expectedPhases.every(([phase, outcome]) => phoneLogs.some(log =>
      log.body?.stringValue === "identity.browser_signin" && attribute(log, "sync.phase") === phase &&
      attribute(log, "identity.signin.outcome") === outcome)), { timeout: 15_000 }).toBe(true)
    const phaseLogs = expectedPhases.map(([phase, outcome]) => phoneLogs.find(log =>
      log.body?.stringValue === "identity.browser_signin" && attribute(log, "sync.phase") === phase &&
      attribute(log, "identity.signin.outcome") === outcome))
    const traceIds = new Set(phaseLogs.map(log => log?.traceId))
    expect(traceIds.size).toBe(1)
    const traceId = phaseLogs[0]?.traceId
    expect(traceId).toMatch(/^[0-9a-f]{32}$/u)
    expect(phoneLogs.filter(log => log.body?.stringValue === "identity.browser_signin" &&
      ["request", "callback", "adoption", "refresh", "catalog", "boards", "restore"].includes(String(attribute(log, "sync.phase"))))
      .some(log => attribute(log, "identity.signin.outcome") === "failed")).toBe(false)
    expect(phoneSpans.some(span => span.name === "identity.browser_signin.request" && span.traceId === traceId)).toBe(true)
    expect(phoneSpans.some(span => span.name === "identity.browser_signin.callback" && span.traceId === traceId)).toBe(true)

    // A fresh local app still owns its boards; declining sign-in preserves that
    // Identity, while explicit adoption delivers the same board to Bo's devices.
    await phone.route(`${appOrigin}/e2e-empty`, route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Local app reset</title>" }), { times: 1 })
    await phone.goto(`${appOrigin}/e2e-empty`)
    await phone.evaluate(async () => {
      for (const database of await indexedDB.databases()) {
        if (!database.name) continue
        await new Promise<void>((resolve, reject) => {
          const deletion = indexedDB.deleteDatabase(database.name!)
          deletion.onsuccess = () => resolve()
          deletion.onerror = () => reject(deletion.error)
          deletion.onblocked = () => reject(new Error("Isolated app database still open"))
        })
      }
      localStorage.clear()
      sessionStorage.clear()
    })
    await phone.goto(baseURL!)
    await expect(phone.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
    const guest = await phone.evaluate(async () => {
      const app = (await import("/src/state.ts")).useTincanban()
      return { personId: app.getCurrentProfile()!.identity.personId, workspaceId: app.activeWorkspace.id }
    })
    await phone.getByRole("button", { name: "Add item to To do", exact: true }).click()
    const localItem = phone.getByRole("dialog", { name: "Item details", exact: true })
    await localItem.getByLabel("Title *", { exact: true }).fill("Keep my phone draft")
    await localItem.getByRole("button", { name: "Save item", exact: true }).click()
    await expect(phone.getByRole("button", { name: /Open Keep my phone draft/u })).toBeVisible()
    await approveApplicationDevice(phone, appOrigin, personId, "stay")
    expect(await phone.evaluate(async () => (await import("/src/state.ts")).useTincanban().getCurrentProfile()!.identity.personId)).toBe(guest.personId)
    await expect(phone.getByRole("button", { name: /Open Keep my phone draft/u })).toBeVisible()
    await expect(phone.getByLabel("Workspace role: owner")).toBeVisible()
    await approveApplicationDevice(phone, appOrigin, personId, "add")
    expect(await phone.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)).toBe(guest.workspaceId)
    await expect(phone.getByRole("button", { name: /Open Keep my phone draft/u })).toBeVisible()
    await expect(phone.getByLabel("Workspace role: owner")).toBeVisible()
    await desktop.reload()
    await expect(desktop.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
    await expect.poll(() => desktop.evaluate(async () => {
      const app = (await import("/src/state.ts")).useTincanban()
      return app.availableWorkspaces.value.map(workspace => workspace.id)
    }), { timeout: 45_000 }).toContain(guest.workspaceId)
    await desktop.evaluate(async workspaceId => (await import("/src/state.ts")).useTincanban().switchWorkspace(workspaceId), guest.workspaceId)
    await expect(desktop.getByRole("button", { name: /Open Keep my phone draft/u })).toBeVisible({ timeout: 30_000 })
    await expect(desktop.getByLabel("Workspace role: owner")).toBeVisible()
    await desktop.getByRole("button", { name: "Settings", exact: true }).click()
    await desktop.getByRole("button", { name: "Add another device", exact: true }).click()
    const deviceInvitation = desktop.getByRole("dialog", { name: "Device sync", exact: true })
    await expect(deviceInvitation.getByRole("img", { name: "Pairing QR code", exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(deviceInvitation.getByLabel("Pairing link", { exact: true })).toHaveValue(/https?:\/\/.+/u)
    await expect(deviceInvitation.getByLabel("Identity invitation", { exact: true })).toHaveCount(0)
  } finally {
    await Promise.allSettled([peerContext.close(), phoneContext.close(), rusty.close()])
  }
})

function logRecords(payload: OtlpLogs): LogRecord[] {
  return (payload.resourceLogs ?? []).flatMap(resource => (resource.scopeLogs ?? []).flatMap(scope => scope.logRecords ?? []))
}

function traceSpans(payload: OtlpTraces): Span[] {
  return (payload.resourceSpans ?? []).flatMap(resource => (resource.scopeSpans ?? []).flatMap(scope => scope.spans ?? []))
}

function attribute(record: LogRecord, key: string): unknown {
  const value = record.attributes?.find(item => item.key === key)?.value
  return value && Object.values(value)[0]
}
