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

async function enrollColdManager(source: Page, target: Page) {
  const enrollment = await source.evaluate(async () => {
    const sdk = await import("/vendor/meta-mesh/packages/mesh-identity/src/index.ts")
    const { createDeviceEnrollmentInvite } = await import("/vendor/meta-mesh/packages/mesh-pairing/src/index.ts")
    const { IdentityDocumentStore } = await import("/src/identityDocumentStore.ts")
    const { MESH_ROUTE_SIGNATURE_DOMAIN } = await import("/vendor/meta-mesh/packages/mesh-replication/src/index.ts")
    const owner = await new sdk.BrowserIdentityStore({ storageKey: "meta-mesh.identity.profile.v1" }).bootstrap()
    const device = await sdk.createIdentityEnrollmentDevice("Offline phone manager")
    const invitation = createDeviceEnrollmentInvite("offline-fixture-endpoint", "offline-fixture-secret", owner)
    const request = await sdk.createIdentityDeviceEnrollmentRequest(device, invitation, {
      displayName: "Offline phone manager", fullRecoveryConsent: false,
    })
    const certificate = await sdk.issueIdentityDeviceEnrollment(owner, request, invitation, [owner.certificate])
    const certificates = [owner.certificate, certificate]
    const profileState = await sdk.readIdentityProfileState(JSON.parse(localStorage.getItem(
      `meta-mesh.identity.profile-state.v1.${owner.identity.personId}`)!), owner.identity, certificates)
    const document = await IdentityDocumentStore.open({ identity: owner.identity, profileState, certificates })
    await document.mergeAuthorityView(await sdk.createIdentityAuthorityView(owner.identity, {
      certificates, revocations: [],
    }, profileState))
    const issuedAt = new Date().toISOString()
    const route = await sdk.signEnvelope(owner.privateKeys.devicePrivateKey, {
      kind: "mesh-device-route" as const, version: 1 as const, personId: owner.identity.personId, deviceId: owner.device.deviceId,
      scopeId: `mesh-identity:${owner.identity.personId}`,
      instanceId: "closed-source", endpoint: "iroh://closed-source", sequence: 1, issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + 600_000).toISOString() }, owner.device.deviceId, MESH_ROUTE_SIGNATURE_DOMAIN)
    const peerContact = { kind: "mesh-identity-peer-contact" as const, version: 1 as const,
      personId: owner.identity.personId, deviceId: owner.device.deviceId, route }
    return { identity: owner.identity, device: device.device, certificate, certificates, profileState, peerContact,
      privateKey: sdk.toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", device.privateKey))) }
  })
  await target.goto(identityOrigin!)
  await target.evaluate(async enrollment => {
    const sdk = await import("/vendor/meta-mesh/packages/mesh-identity/src/index.ts")
    const { IdentityDocumentStore } = await import("/src/identityDocumentStore.ts")
    const { IdentityPeerContactStore } = await import("/src/identityPeerContacts.ts")
    const devicePrivateKey = await crypto.subtle.importKey("pkcs8", sdk.fromBase64Url(enrollment.privateKey),
      { name: "Ed25519" }, true, ["sign"])
    await new sdk.BrowserIdentityStore({ storageKey: "meta-mesh.identity.profile.v1", requirePersistence: true })
      .adoptEnrolledDevice({ identity: enrollment.identity, device: enrollment.device, certificate: enrollment.certificate,
        privateKeys: { devicePrivateKey } }, enrollment.certificates, { consentToReplaceExistingIdentity: true })
    await IdentityDocumentStore.open(enrollment)
    new IdentityPeerContactStore().save(enrollment.identity.personId, enrollment.device.deviceId, enrollment.peerContact)
    if (sdk.identityProfileRustyServicePins(enrollment.profileState).length !== 0) throw new Error("Cold fixture already knows the catalog service")
  }, enrollment)
  await target.close()
}

for (const coldProfile of [false, true]) {
test(`Given remotely saved boards and the source device closed${coldProfile ? " with a cold enrolled Identity profile" : ""}, when ordinary Identity login runs on a clean app device, then original cards load after interrupted restore and survive reload`, async ({ browser, baseURL }) => {
  test.skip(coldProfile && !process.env.IDENTITY_CATALOG_E2E_ORIGIN, "A configured catalog origin is required")
  test.setTimeout(180_000)
  const source = await browser.newContext()
  const coldTarget = coldProfile ? await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true }) : undefined
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
    if (coldTarget) {
      await enrollColdManager(page, await coldTarget.newPage())
      rusty = await startIdentityRustyService(new URL(baseURL!).origin, new URL(process.env.IDENTITY_CATALOG_E2E_ORIGIN!).host)
    }
    await page.goto(baseURL!)
    const initialAppPersonId = await page.evaluate(async () => {
      const app = (await import("/src/state.ts")).useTincanban()
      await app.whenReady()
      return app.getCurrentProfile()!.identity.personId
    })
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    // Hold the old startup projection after it is visible but before readiness.
    // Approval must not race that projection and later lose the selected board.
    await page.route("**/src/statePersistence.ts", async route => {
      const response = await route.fetch()
      const original = await response.text()
      const marker = 'await step("workspace-migrations"'
      if (!original.includes(marker)) throw new Error("Startup acceptance gate marker is missing")
      const gate = 'if (window.location.pathname === "/identity/return") await new Promise(resolve => { window.__releaseIdentityStartup = resolve }); '
      const headers = response.headers()
      delete headers.etag
      headers["cache-control"] = "no-store"
      await route.fulfill({ response, headers, body: original.replace(marker, `${gate}${marker}`) })
    })
    await approve(page)
    await page.waitForFunction(() => typeof (window as unknown as { __releaseIdentityStartup?: unknown }).__releaseIdentityStartup === "function")
    await page.evaluate(async () => {
      await import("/src/components/IdentityPortalEnrollmentDialog.vue")
      await new Promise(resolve => requestAnimationFrame(resolve))
    })
    await expect(page.getByRole("dialog", { name: "Identity profile", exact: true })).toHaveCount(0)
    expect(await page.evaluate(async () => (await import("/src/state.ts")).useTincanban().getCurrentProfile()!.identity.personId)).toBe(initialAppPersonId)
    await page.evaluate(() => (window as unknown as { __releaseIdentityStartup(): void }).__releaseIdentityStartup())
    await page.unroute("**/src/statePersistence.ts")
    await expect(page.getByRole("dialog", { name: "Identity profile", exact: true })).toBeHidden({ timeout: 30_000 })
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0)
    await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
    await page.getByRole("button", { name: "New workspace", exact: true }).click()
    const create = page.getByRole("dialog", { name: "Create workspace" })
    await create.getByLabel("Title", { exact: true }).fill("Original restored board")
    await create.getByRole("button", { name: "Create", exact: true }).click()
    await page.getByRole("region", { name: "Original restored board", exact: true }).waitFor().catch(async cause => {
      const snapshot = await page.evaluate(async () => {
        const app = (await import("/src/state.ts")).useTincanban()
        return { activeTitle: app.activeWorkspace.title,
          available: app.availableWorkspaces.value.map(workspace => workspace.title),
          alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent),
          creating: document.querySelector('.workspace-create-dialog form')?.getAttribute('aria-busy') }
      })
      throw new Error(`Source board creation did not complete: ${cause}; ${JSON.stringify(snapshot)}`)
    })
    await page.getByRole("button", { name: "Add item to To do" }).click()
    const item = page.getByRole("dialog", { name: "Item details" })
    await item.getByLabel("Title *").fill("Recovered card")
    await item.getByRole("button", { name: "Save item" }).click()
    const originalWorkspaceId = await page.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)
    rusty ??= await startIdentityRustyService(new URL(baseURL!).origin)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const panel = page.getByRole("dialog", { name: "Device sync" }).getByRole("region", { name: "Rusty", exact: true })
    await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await panel.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    if (!coldProfile) await approve(page)
    if (!await page.getByRole("dialog", { name: "Device sync" }).isVisible()) await page.getByRole("button", { name: "Sync", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Device sync" }).getByRole("region", { name: "Rusty", exact: true })).toContainText("Synced", { timeout: 45_000 })
    await panel.getByRole("button", { name: "Sync now", exact: true }).click()
    await expect(page.locator(".rusty-profile-connection").getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    const state = await source.storageState({ indexedDB: true })
    state.origins = state.origins.filter(origin => origin.origin === identityOrigin)
    state.cookies = []
    await source.close()
    const target = coldTarget ?? await browser.newContext({ storageState: state })
    try {
      const selectedKinds: string[] = []
      await target.route("https://telemetry.invalid/v1/**", async route => {
        if (route.request().method() === "POST" && new URL(route.request().url()).pathname === "/v1/logs") {
          const payload = (route.request().postDataJSON() ?? {}) as { resourceLogs?: Array<{ scopeLogs?: Array<{
            logRecords?: Array<{ body?: { stringValue?: string }; attributes?: Array<{ key: string; value?: { stringValue?: string } }> }>
          }> }> }
          for (const record of payload.resourceLogs?.flatMap(resource => resource.scopeLogs?.flatMap(scope => scope.logRecords ?? []) ?? []) ?? []) {
            const attribute = (key: string) => record.attributes?.find(attribute => attribute.key === key)?.value?.stringValue
            if (record.body?.stringValue === "identity.browser_signin" && attribute("sync.phase") === "selection") {
              selectedKinds.push(attribute("code.operation") ?? "missing")
            }
          }
        }
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}", headers: {
          "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, OPTIONS",
        } })
      })
      const fresh = await target.newPage()
      const pageErrors: string[] = []
      fresh.on("pageerror", cause => { pageErrors.push(cause.message) })
      const catalogResponses: Array<{ status: number; entries: number }> = []
      fresh.on("response", async response => {
        if (new URL(response.url()).pathname === "/v2/identity/catalog-access/request") {
          const body = await response.json().catch(() => ({}))
          catalogResponses.push({ status: response.status(), entries: body.envelopes?.length ?? -1 })
        }
      })
      await target.route(`${rusty.origin}/v2/scopes/**`, route => new URL(fresh.url()).origin === new URL(baseURL!).origin ? route.abort() : route.continue())
      if (coldProfile) await target.route(`${rusty.origin}/v2/identity/catalog-access/request`, route => route.abort())
      await fresh.goto(baseURL!)
      if (coldProfile) await fresh.getByRole("button", { name: "Menu", exact: true }).click()
      await fresh.getByRole("button", { name: "Sign in", exact: true }).click().catch(async cause => {
        throw new Error(`${cause}; ${JSON.stringify({ pageErrors, page: await fresh.locator("body").innerText() })}`)
      })
      await approve(fresh)
      if (coldProfile) {
        await expect(fresh.getByRole("alert").filter({ hasText: /signed in.*catalog could not be received/i })).toBeVisible({ timeout: 30_000 })
        await expect(fresh.getByRole("dialog", { name: "Identity profile", exact: true })).toBeHidden()
        await fresh.reload()
        await expect(fresh.getByRole("alert").filter({ hasText: /signed in.*catalog could not be received/i })).toBeVisible({ timeout: 30_000 })
        expect(await fresh.evaluate(async () => (await import("/src/state.ts")).useTincanban().getCurrentProfile()!.certificate.payload.canEnrollDevices)).toBe(false)
        await target.unroute(`${rusty.origin}/v2/identity/catalog-access/request`)
        await fresh.getByRole("button", { name: "Retry loading boards", exact: true }).click()
        await approve(fresh)
      }
      await expect(fresh.getByRole("alert").filter({ hasText: /signed in.*boards/i })).toBeVisible({ timeout: 30_000 })
      await expect(fresh.getByRole("dialog", { name: "Identity profile", exact: true })).toBeHidden()
      await expect(fresh.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0)
      await fresh.reload()
      await expect(fresh.getByRole("alert").filter({ hasText: /signed in.*boards/i })).toBeVisible({ timeout: 30_000 })
      expect(selectedKinds).toEqual([])
      await target.unroute(`${rusty.origin}/v2/scopes/**`)
      await fresh.setViewportSize({ width: 390, height: 844 })
      await fresh.getByRole("button", { name: "Retry loading boards", exact: true }).click()
      await expect(fresh.getByRole("region", { name: "Original restored board", exact: true })).toBeVisible({ timeout: 30_000 }).catch(async cause => {
        const snapshot = await fresh.evaluate(async () => {
          const storage = (await import("/src/storage.ts")).defaultStorage
          const root = await storage.loadPersonalRoot()
          const replicas = await import("/src/sync/privateReplicaRepository.ts")
          const profile = (await import("/src/state.ts")).useTincanban().getCurrentProfile()!
          const app = (await import("/src/state.ts")).useTincanban()
          return { pathname: window.location.pathname, active: app.activeWorkspace.id,
            board: app.activeBoard.value?.id,
            references: Object.values(root?.workspaces ?? {}).map(reference => ({ id: reference.workspaceId, forgotten: reference.forgotten })),
            loaded: (await storage.listWorkspaces()).map(workspace => ({ id: workspace.id, title: workspace.title })),
            catalogs: (await replicas.getIdentityReplicaConfigurations(profile.identity.personId)).map(config => ({ scope: config.scopeId, cursor: config.cursor })),
            boards: (await replicas.getReplicaConfigurations(profile.identity.personId)).map(config => ({ workspace: config.workspaceId, cursor: config.cursor })),
            alerts: [...document.querySelectorAll('[role="alert"]')].map(node => node.textContent) }
        })
        throw new Error(`${cause instanceof Error ? cause.message : cause}; ${JSON.stringify({ catalogResponses, snapshot })}`)
      })
      await expect(fresh.getByRole("button", { name: "Open Recovered card", exact: true })).toBeVisible()
      await fresh.evaluate(async () => (await import("/src/sync/telemetry.ts")).retryTelemetry())
      await expect.poll(() => selectedKinds).toContain("saved")
      await fresh.reload()
      await expect(fresh.getByRole("region", { name: "Original restored board", exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(fresh.getByRole("button", { name: "Open Recovered card", exact: true })).toBeVisible()
      expect(await fresh.evaluate(async () => (await (await import("/src/storage.ts")).defaultStorage.listWorkspaces()).find(item => item.title === "Original restored board")?.id)).toBe(originalWorkspaceId)
      await fresh.evaluate(async () => (await import("/src/sync/telemetry.ts")).retryTelemetry())
      expect(selectedKinds).toContain("saved")
    } finally { await target.close() }
  } finally { await source.close(); await coldTarget?.close(); await rusty?.close() }
})
}
