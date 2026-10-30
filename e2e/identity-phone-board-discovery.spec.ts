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
  await expect(portal.locator(".identity-profile-card .identity-avatar img")).toHaveAttribute("src", /^data:image\/(?:webp|jpeg);base64,/u)
  const uploadedPhoto = portal.locator(".identity-profile-card .identity-avatar img")
  await expect.poll(() => uploadedPhoto.evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth, height: image.naturalHeight,
  }))).toEqual({ width: 128, height: 128 })
  return (await portal.locator(".identity-id-badge").getAttribute("data-identity-id"))!
}

async function approveApplicationDevice(page: Page, appOrigin: string, personId: string,
  localBoardChoice?: "add" | "stay", afterApproval?: () => Promise<void>, expectBoardPending = false): Promise<void> {
  await page.addInitScript(({ expectedOrigin }) => {
    if (location.origin !== expectedOrigin || location.pathname !== "/identity/return") return
    const saveFailureKey = "tincanban.e2e.signin-save-failure"
    sessionStorage.removeItem(saveFailureKey)
    const observeSaveFailure = () => {
      if (document.querySelector(".save-state-error")) sessionStorage.setItem(saveFailureKey, "true")
    }
    new MutationObserver(observeSaveFailure).observe(document, { subtree: true, childList: true, attributes: true })
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
  await afterApproval?.()
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
  if (callbackAlert.length && !expectBoardPending) throw new Error(`Identity callback rejected: ${callbackAlert.join("; ")}`)
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
  try {
    await ownerPortal.getByRole("tab", { name: "Profile", exact: true }).click({ timeout: 45_000 })
    await expect(ownerPortal.getByRole("heading", { name: "Bo catalog owner", exact: true })).toBeVisible({ timeout: 45_000 })
  } catch {
    const status = await ownerPortal.evaluate(async () => {
      const { createIdentityPortalController } = await import("/src/identityPortalController.ts")
      const state = createIdentityPortalController().state.value
      return { status: state.deviceEnrollmentStatus, error: state.error }
    })
    throw new Error(`The source did not finish enrolled-device profile sync: ${JSON.stringify(status)}`)
  }
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
  const profileStatus = rusty.locator(".rusty-server")
  await expect(profileStatus).toBeVisible({ timeout: 30_000 })
  const delivery = await terminalProfileDelivery(profileStatus)
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

type ProfileStatusReader = { locator(selector: string): { allTextContents(): Promise<string[]> } }

/** Return the observed delivery; another background sync may start immediately afterward. */
async function terminalProfileDelivery(profileStatus: ProfileStatusReader): Promise<string[]> {
  let delivery: string[] = []
  await expect.poll(async () => {
    const alerts = await profileStatus.locator('[role="alert"]').allTextContents()
    const rows = await profileStatus.locator(".rusty-connection").allTextContents()
    const visibleAlerts = alerts.map(text => text.trim()).filter(Boolean)
    const visibleRows = rows.map(text => text.trim())
    delivery = visibleRows
    return { terminal: visibleAlerts.length > 0 || visibleRows.some(text => /Synced|Sync paused|Check overdue|not configured|Removal pending/iu.test(text)),
      alerts: visibleAlerts, rows: visibleRows }
  }, { timeout: 30_000 }).toMatchObject({ terminal: true, alerts: [] })
  return delivery
}

test("Given a confirmed profile delivery followed by a new sync, when setup checks readiness, then retain the confirmed snapshot", async () => {
  let rowReads = 0
  const status = { locator: (selector: string) => ({ allTextContents: async () => selector === '[role="alert"]' ? [] :
    [rowReads++ === 0 ? "Rusty Synced" : "Rusty Syncing"] }) }
  expect(await terminalProfileDelivery(status)).toEqual(["Rusty Synced"])
})

test("Given an overdue profile delivery, when setup checks readiness, then retain that failure instead of reporting Synced", async () => {
  const status = { locator: (selector: string) => ({ allTextContents: async () => selector === '[role="alert"]' ? [] : ["Rusty Check overdue"] }) }
  expect(await terminalProfileDelivery(status)).toEqual(["Rusty Check overdue"])
})

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
  const identityDiagnostics: Array<{ page: string; phase?: string; errorType?: string; elapsedMs?: number }> = []
  for (const [name, portal] of [["source", ownerPortal], ["phone", phone]] as const) {
    portal.on("console", async message => {
      if (!message.text().startsWith("Identity peer ")) return
      const fields = await message.args()[1]?.jsonValue().catch(() => null) as Record<string, unknown> | null
      identityDiagnostics.push({ page: name,
        phase: typeof fields?.phase === "string" ? fields.phase : undefined,
        errorType: typeof fields?.errorType === "string" ? fields.errorType : undefined,
        elapsedMs: typeof fields?.elapsedMs === "number" ? fields.elapsedMs : undefined })
    })
  }
  const phoneCatalogTraffic: Array<{ path: string; status: number }> = []
  phone.on("response", response => {
    const url = new URL(response.url())
    if (url.origin === rusty.origin && url.pathname.startsWith("/v2/identity/")) {
      phoneCatalogTraffic.push({ path: url.pathname.replace(/[A-Za-z0-9_-]{40,}/gu, "<id>"), status: response.status() })
    }
  })
  let releasePhonePeerReconnect: (() => void) | undefined
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

    await desktop.goto(baseURL!)
    await expect(desktop.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
    await approveApplicationDevice(desktop, appOrigin, personId)

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

    await createJobSearchWorkspace(desktop, "Bo Job search")
    const actualWorkspaceId = await desktop.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)
    await desktop.getByRole("region", { name: "Lead", exact: true })
      .getByRole("button", { name: "Add lead to Lead", exact: true }).click()
    const create = desktop.getByRole("dialog", { name: "Add item" })
    await create.getByLabel("Company *").fill("Bo private opportunity")
    await create.getByLabel("Role *").fill("Senior engineer")
    await create.getByRole("button", { name: "Create item", exact: true }).click()
    await expect(desktop.getByRole("button", { name: /Open Bo private opportunity/u })).toBeVisible()
    // Keep initial empty-catalog sign-in legitimate, then take the phone offline
    // before the source creates the signed Rusty link it must later discover.
    await phonePortal.close()
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
    await expect.poll(() => identityRustyPinOrigins(ownerPortal, personId), { timeout: 30_000 }).toContain(rusty.origin)
    await joinAsEditor(desktop, peer)

    let phonePeerReconnectStarted = false
    const phonePeerReconnectGate = new Promise<void>(resolve => { releasePhonePeerReconnect = resolve })
    await phoneContext.routeWebSocket("**/*", async socket => {
      if (new URL(phone.url()).origin !== new URL(identityOrigin!).origin ||
          new URL(socket.url()).protocol !== "wss:") {
        socket.connectToServer()
        return
      }
      const server = socket.connectToServer()
      const buffered: Array<string | Buffer> = []
      let released = false
      server.onMessage(message => {
        phonePeerReconnectStarted = true
        if (released) socket.send(message)
        else buffered.push(message)
      })
      await phonePeerReconnectGate
      released = true
      for (const message of buffered) socket.send(message)
    })
    let phoneIdentityReturnRequests = 0
    phone.on("request", request => {
      const url = new URL(request.url())
      if (url.origin === appOrigin && url.pathname === "/identity/return") phoneIdentityReturnRequests += 1
    })
    try {
      await approveApplicationDevice(phone, appOrigin, personId, undefined, async () => {
        try {
          await expect.poll(() => phonePeerReconnectStarted, { timeout: 10_000 }).toBe(true)
          const pending = phone.getByRole("status", { name: "Checking your Identity and boards…", exact: true })
          await expect(pending).toBeVisible({ timeout: 15_000 })
          await expect(phone.getByRole("button", { name: "Approve app device", exact: true })).toBeDisabled()
          await expect(phone).toHaveURL(url => url.origin === new URL(identityOrigin!).origin && url.pathname === "/authorize")
          expect(phoneIdentityReturnRequests).toBe(0)
        } finally {
          releasePhonePeerReconnect()
        }
      })
    }
    catch (cause) {
      const phases = phoneLogs.filter(log => log.body?.stringValue === "identity.browser_signin")
        .map(log => ({ phase: attribute(log, "sync.phase"), outcome: attribute(log, "identity.signin.outcome") }))
      const sourceMessages = await ownerPortal.locator('[role="alert"], [role="status"]').allTextContents()
      const sourceState = await ownerPortal.evaluate(async () => {
        const { createIdentityPortalController } = await import("/src/identityPortalController.ts")
        const state = createIdentityPortalController().state.value
        return { status: state.deviceEnrollmentStatus, error: state.error, notice: state.notice }
      })
      throw new Error(`${cause instanceof Error ? cause.message : "Phone callback failed"}; phases: ${JSON.stringify(phases)}; errors: ${JSON.stringify(exceptionDetails(phoneSpans))}; Identity diagnostics: ${JSON.stringify(identityDiagnostics)}; Rusty: ${JSON.stringify(phoneCatalogTraffic)}; source messages: ${JSON.stringify(sourceMessages)}; source state: ${JSON.stringify(sourceState)}`, { cause })
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
    await expect(phone.locator(".save-state-error")).toHaveCount(0)
    expect(await phone.evaluate(() => sessionStorage.getItem("tincanban.e2e.signin-save-failure"))).toBeNull()
    expect(await phone.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id))
      .not.toBe(anonymous.id)
    const profile = await phone.evaluate(async () => {
      const storage = await import("/src/storage.ts")
      return storage.defaultStorage.loadPersonalRoot()
    })
    expect(profile?.identity.personId).toBe(personId)
    expect(profile?.photo?.avatarData).toMatch(/^data:image\/(?:webp|jpeg);base64,/u)

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
      .toMatch(/^data:image\/(?:webp|jpeg);base64,/u)

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
    expect(restored.photo).toMatch(/^data:image\/(?:webp|jpeg);base64,/u)

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
    releasePhonePeerReconnect?.()
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

async function retainedBoardAccess(page: Page, workspaceId: string) {
  return page.evaluate(async id => {
    const { defaultStorage } = await import("/src/storage.ts")
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { workspaceRole } = await import("/src/sync/changeAuthorization.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const saved = await defaultStorage.loadWorkspaceDoc(id)
    if (!saved) return null
    try {
      return { workspaceId: saved.doc.id, ownerPersonId: saved.doc.ownerPersonId,
        role: await workspaceRole(saved.doc, await bootstrapIdentity()) }
    } finally { A.free(saved.doc) }
  }, workspaceId)
}

test("Given an approved phone and an owner board with no Rusty copy, when sign-in loads its private catalog, then recover the original board through P2P and retain it after reload", async ({ page: desktop, context, browser, baseURL }) => {
  test.setTimeout(240_000)
  const appOrigin = new URL(baseURL!).origin
  const portal = await context.newPage()
  const phoneContext = await browser.newContext()
  const phone = await phoneContext.newPage()
  const phonePortal = await phoneContext.newPage()
  const rusty = await startIdentityRustyService(`${appOrigin},${identityOrigin}`)
  const diagnostics: string[] = []
  for (const [label, target] of [["source", desktop], ["phone", phone]] as const) {
    target.on("console", message => { if (/identity.peer-recovery|workspace transfer|bootstrap/i.test(message.text())) diagnostics.push(`${label}: ${message.text()}`) })
  }
  try {
    const personId = await createOwnerIdentity(portal)
    await desktop.goto(baseURL!)
    await expect(desktop.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
    await approveApplicationDevice(desktop, appOrigin, personId)
    await enrollPhoneManager(portal, phonePortal, personId)
    // Connect only the starter. The later board has no Rusty connection or stored copy.
    await connectRusty(desktop, rusty.origin)
    await createJobSearchWorkspace(desktop, "P2P only board")
    const workspaceId = await desktop.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)
    await desktop.getByRole("region", { name: "Lead", exact: true }).getByRole("button", { name: "Add lead to Lead", exact: true }).click()
    const item = desktop.getByRole("dialog", { name: "Add item" })
    await item.getByLabel("Company *").fill("Retained only by source")
    await item.getByLabel("Role *").fill("P2P recovery")
    await item.getByRole("button", { name: "Create item", exact: true }).click()
    await expect(desktop.getByRole("button", { name: /Open Retained only by source/u })).toBeVisible()
    await expect.poll(() => desktop.evaluate(async id => {
      const profile = (await import("/src/domain/identity.ts")).bootstrapIdentity()
      const configs = await (await import("/src/sync/privateReplicaRepository.ts")).getReplicaConfigurations((await profile).identity.personId)
      const sources = await (await import("/src/sync/identityPeerRecoveryCatalog.ts")).readIdentityPeerRecovery((await profile).identity.personId)
      return { copies: configs.filter(config => config.workspaceId === id).length, source: sources.some(source => source.workspaceId === id) }
    }, workspaceId), { timeout: 30_000 }).toEqual({ copies: 0, source: true })
      const invite = await desktop.evaluate(async id => {
        const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
        return (await (await import("/src/sync/identityPeerRecoveryCatalog.ts")).readIdentityPeerRecovery(profile.identity.personId))
          .find(source => source.workspaceId === id)!.invite
      }, workspaceId)
      const strangerContext = await browser.newContext()
      try {
        const stranger = await strangerContext.newPage()
        await stranger.goto(baseURL!)
        await expect(stranger.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
        const denied = await stranger.evaluate(async invitation => {
          const { bootstrapIdentity } = await import("/src/domain/identity.ts")
          const { irohTransport } = await import("/src/sync/irohTransport.ts")
          const { meshNetworkConnection } = await import("/vendor/meta-mesh/packages/mesh-transport/src/index.ts")
          const { encodePairingFrame } = await import("/vendor/meta-mesh/packages/mesh-pairing/src/index.ts")
          const { createEnrollmentRequest } = await import("/src/sync/enrollment.ts")
          const node = await irohTransport.start(crypto.getRandomValues(new Uint8Array(32)))
          try {
            const { meshIngressBudgetProfile } = await import("/src/iroh.ts")
            const connection = meshNetworkConnection(await node.dial(invitation.issuerEndpoint), meshIngressBudgetProfile())
            const stream = await connection.openStream()
            await stream.send(encodePairingFrame("enroll-request", invitation.secret, await createEnrollmentRequest(invitation, await bootstrapIdentity())))
            await stream.closeSend()
            try { await stream.read(); return false } catch { return true }
          } finally { await node.close("Foreign recovery check complete") }
        }, invite)
        expect(denied).toBe(true)
        expect(await desktop.evaluate(async () => (await import("/src/sync/meshTrace.ts")).meshTraceSnapshot().some(event =>
          event.event === "identity.peer-recovery.failed" && event.reason === "Recovery requires an already approved Identity device"))).toBe(true)
      } finally { await strangerContext.close() }
    await phone.goto(baseURL!)
    await expect(phone.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
    await approveApplicationDevice(phone, appOrigin, personId)
    await expect(phone.getByRole("button", { name: /Open Retained only by source/u })).toBeVisible({ timeout: 90_000 })
    expect(await phone.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)).toBe(workspaceId)
    // Recovery publishes before connection cleanup; verify durable access instead of a transient trace event.
    expect(await retainedBoardAccess(phone, workspaceId)).toEqual({ workspaceId, ownerPersonId: personId, role: "owner" })
    expect(await phone.evaluate(async id => {
      const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
      return (await (await import("/src/sync/privateReplicaRepository.ts")).getReplicaConfigurations(profile.identity.personId))
        .filter(config => config.workspaceId === id).length
    }, workspaceId)).toBe(0)
    await phone.getByRole("button", { name: /Open Retained only by source/u }).click()
    await phone.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Edit", exact: true }).click()
    const edit = phone.getByRole("dialog", { name: "Edit item" })
    await edit.getByLabel("Role *").fill("Changed through P2P")
    await edit.getByRole("button", { name: "Save changes", exact: true }).click()
    await expect(desktop.getByRole("button", { name: /Open Retained only by source — Changed through P2P/u })).toBeVisible({ timeout: 45_000 })
    await desktop.close()
    await phone.setViewportSize({ width: 390, height: 844 })
    await phone.reload()
    await expect(phone.getByRole("button", { name: /Open Retained only by source/u })).toBeVisible({ timeout: 30_000 })
    expect(await phone.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)).toBe(workspaceId)
    expect(await retainedBoardAccess(phone, workspaceId)).toEqual({ workspaceId, ownerPersonId: personId, role: "owner" })
  } finally {
    console.log("P2P recovery diagnostics", diagnostics)
    await Promise.allSettled([phoneContext.close(), rusty.close()])
  }
})

