import { expect, test, type BrowserContext, type Page } from "./support/coverage"
import * as Automerge from "@automerge/automerge"
import { identityProfileRustyServicePins, readIdentityProfileStateWithRevocations } from "@meta-uber/mesh-identity"
import type { PersonalIdentityDocument } from "@meta-uber/mesh-replication/identity-mesh"
import { readStoredBoardAccess } from "./support/identityRustyFixture"
import { startIdentityRustyService } from "./support/rustyService"
import { createJobSearchWorkspace, addJobSearchLead as addLead } from "./support/workspaces"

const identityOrigin = process.env.IDENTITY_E2E_ORIGIN

async function workspaceConnectionFingerprint(page: Page, workspaceId: string): Promise<string> {
  return page.evaluate(async id => {
    const { peerStore } = await import("/src/sync/peerStore.ts")
    const { sha256Base64Url } = await import("/src/domain/identity.ts")
    const credential = await peerStore.getWorkspaceCredential(id)
    if (!credential) throw new Error("Workspace connection is unavailable")
    return sha256Base64Url(new TextEncoder().encode(credential.transportSecret))
  }, workspaceId)
}

async function connectRustyThroughIdentity(page: Page, rustyOrigin: string): Promise<void> {
  const appOrigin = new URL(page.url()).origin
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const rusty = page.getByRole("region", { name: "Rusty", exact: true })
  await rusty.getByRole("button", { name: "Add Rusty", exact: true }).click()
  await rusty.getByLabel("Address", { exact: true }).fill(rustyOrigin)
  await rusty.getByRole("button", { name: "Connect", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Authorize app device", exact: true })).toBeVisible({ timeout: 30_000 })
  await page.getByLabel("Allow this app device and add the listed verified Rusty service keys to the shared Identity catalog.").check()
  await page.getByRole("button", { name: "Approve device and link services", exact: true }).click()
  await page.waitForURL(url => url.origin === appOrigin && url.pathname !== "/identity/return", { timeout: 30_000 })
  await expect(page.getByRole("dialog", { name: "Identity profile", exact: true })).toBeHidden({ timeout: 30_000 })
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await expect(rusty.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
    .toBeVisible({ timeout: 45_000 })
  await rusty.getByRole("button", { name: "Sync now", exact: true }).click()
  await expect(rusty.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled({ timeout: 45_000 })
  await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
}

async function identityRustyPinOrigins(portal: Page, personId: string): Promise<string[]> {
  const bytes = await portal.evaluate(async id => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("meta-mesh-identity", 2)
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    try {
      return await new Promise<number[]>((resolve, reject) => {
        const request = database.transaction("personal-documents", "readonly").objectStore("personal-documents").get(id)
        request.onerror = () => reject(request.error)
        request.onsuccess = () => resolve(request.result ? Array.from(request.result.bytes as Uint8Array) : [])
      })
    } finally {
      database.close()
    }
  }, personId)
  if (!bytes.length) return []
  const document = Automerge.load<PersonalIdentityDocument>(new Uint8Array(bytes))
  const profileState = await readIdentityProfileStateWithRevocations(document.profileState,
    { personId: document.personId, publicKey: document.identityPublicKey, displayName: "" },
    document.certificates, document.revocations)
  return identityProfileRustyServicePins(profileState).map(pin => pin.origin)
}

async function enrollPhoneManager(ownerPortal: Page, phonePortal: Page, personId: string): Promise<void> {
  await ownerPortal.getByRole("tab", { name: "Devices", exact: true }).click()
  await ownerPortal.getByRole("button", { name: "Manage devices", exact: true }).click()
  await expect(ownerPortal).toHaveURL(/\/devices$/u)
  await ownerPortal.getByRole("button", { name: "Add a device", exact: true }).click()
  await expect(ownerPortal).toHaveURL(/\/devices\/add$/u)
  const invite = ownerPortal.getByRole("link", { name: "Open invite link", exact: true })
  await expect(invite).toBeVisible({ timeout: 30_000 })
  const inviteUrl = await invite.getAttribute("href")
  if (!inviteUrl) throw new Error("Identity did not create a device invitation")
  await phonePortal.goto(inviteUrl)
  await expect(phonePortal.getByRole("heading", { name: "Connect this device", exact: true })).toBeVisible()
  await phonePortal.getByRole("button", { name: "Request connection", exact: true }).click()
  const review = ownerPortal.locator("section.dialog.ui-stack").filter({
    has: ownerPortal.getByRole("heading", { name: "Review device request", exact: true }),
  })
  await expect(review).toBeVisible({ timeout: 30_000 })
  await expect(review.locator('input[name="recovery-transfer"]')).not.toBeChecked()
  await review.getByRole("button", { name: "Approve device", exact: true }).click()
  await expect(phonePortal.getByRole("heading", { name: "Bo recovery owner", exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(phonePortal.locator(".identity-id-badge")).toHaveAttribute("data-identity-id", personId)
  const rootKeyIsAbsent = await phonePortal.evaluate(async () => {
    const raw = localStorage.getItem("meta-mesh.identity.profile.v1")
    if (!raw) return false
    const saved = JSON.parse(raw) as { identity?: unknown; privateKeys?: { identityPrivateKeyPkcs8?: unknown; devicePrivateKeyPkcs8?: unknown } }
    return Boolean(saved.identity && saved.privateKeys?.devicePrivateKeyPkcs8 &&
      saved.privateKeys.identityPrivateKeyPkcs8 === undefined)
  })
  expect(rootKeyIsAbsent).toBe(true)
  await ownerPortal.getByRole("tab", { name: "Profile", exact: true }).click()
  await expect(ownerPortal.getByRole("heading", { name: "Bo recovery owner", exact: true })).toBeVisible({ timeout: 30_000 })
}

async function approveBoAppDevice(page: Page, appOrigin: string, personId: string): Promise<void> {
  await page.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
    await app.whenReady()
  })
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.waitForURL(url => url.origin === identityOrigin && url.pathname.includes("/authorize"), { timeout: 30_000 })
  await page.getByRole("heading", { name: "Authorize app device", exact: true }).waitFor()
  await page.getByLabel("Allow this app to use the Identity shown above.", { exact: true }).check()
  await page.getByRole("button", { name: "Approve app device", exact: true }).click()
  await page.waitForURL(url => url.origin === appOrigin && url.pathname === "/identity/return", { timeout: 30_000 })
  await expect.poll(() => page.evaluate(async () =>
    (await import("/src/state.ts")).useTincanban().getCurrentProfile()?.identity.personId ?? null), { timeout: 45_000 })
    .toBe(personId)
  await expect(page.getByRole("dialog", { name: "Identity profile", exact: true })).toBeHidden({ timeout: 30_000 })
}

test("Given Bo closed the old owner device, when a newly approved Bo app device restores from Rusty, then it keeps the board and Ray's editor membership", async ({ page, browser, baseURL }) => {
  test.skip(!identityOrigin, "Set IDENTITY_E2E_ORIGIN to an isolated Identity portal")
  test.setTimeout(240_000)
  const ownerContext = page.context()
  const portal = await ownerContext.newPage()
  const rayContext = await browser.newContext()
  const ray = await rayContext.newPage()
  const appOrigin = new URL(baseURL!).origin
  const rusty = await startIdentityRustyService(`${appOrigin},${identityOrigin}`)
  let managerContext: BrowserContext | undefined
  let managerPage: Page | undefined
  let newOwnerContext: BrowserContext | undefined

  try {
    await rayContext.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    await portal.goto(identityOrigin!)
    await portal.getByRole("button", { name: "Create identity", exact: true }).click()
    await portal.locator('#create-form input[name="displayName"]').fill("Bo recovery owner")
    await portal.locator("#create-form").getByRole("button", { name: "Create identity", exact: true }).click()
    await portal.getByRole("heading", { name: "Save your recovery" }).waitFor()
    const download = portal.waitForEvent("download")
    await portal.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
    await download
    await portal.locator('input[name="saved-words"]').check()
    await portal.getByRole("button", { name: "Continue to identity", exact: true }).click()
    await portal.getByRole("heading", { name: "Bo recovery owner", exact: true }).waitFor()
    const ownerPersonId = (await portal.locator(".identity-id-badge").getAttribute("data-identity-id"))!

    await page.goto(baseURL!)
    await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
    await page.evaluate(async () => {
      const app = (await import("/src/state.ts")).useTincanban()
      await app.whenReady()
    })
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await page.waitForURL(url => url.origin === identityOrigin && url.pathname.includes("/authorize"), { timeout: 30_000 })
    await page.getByRole("heading", { name: "Authorize app device", exact: true }).waitFor()
    await page.getByLabel("Allow this app to use the Identity shown above.", { exact: true }).check()
    await page.getByRole("button", { name: "Approve app device", exact: true }).click()
    await page.waitForURL(url => url.origin === appOrigin && url.pathname === "/identity/return", { timeout: 30_000 })
    await expect.poll(() => page.evaluate(async () =>
      (await import("/src/state.ts")).useTincanban().getCurrentProfile()?.identity.personId ?? null), { timeout: 45_000 })
      .toBe(ownerPersonId)
    await expect(page.getByRole("dialog", { name: "Identity profile", exact: true })).toBeHidden({ timeout: 30_000 })

    // Enroll a second Identity manager before publishing the app's Rusty
    // catalog. Rusty publishes manager-readable catalog envelopes to the
    // manager devices present at publication time.
    managerContext = await browser.newContext()
    managerPage = await managerContext.newPage()
    await enrollPhoneManager(portal, managerPage, ownerPersonId)

    await createJobSearchWorkspace(page, "Bo recovery board")
    await addLead(page, "Retained opportunity")
    const workspaceId = await page.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)
    const oldOwnerDeviceId = await page.evaluate(async () =>
      (await import("/src/state.ts")).useTincanban().getCurrentProfile()!.device.deviceId)

    await connectRustyThroughIdentity(page, rusty.origin)
    await expect.poll(() => identityRustyPinOrigins(portal, ownerPersonId), { timeout: 30_000 }).toContain(rusty.origin)
    await expect.poll(() => identityRustyPinOrigins(managerPage!, ownerPersonId), { timeout: 30_000 }).toContain(rusty.origin)

    await ray.goto(baseURL!)
    const editorPersonId = await ray.evaluate(async () =>
      (await import("/src/domain/identity.ts")).bootstrapIdentity().then(profile => profile.identity.personId))
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const host = page.getByRole("dialog", { name: "Device sync" })
    await host.getByRole("button", { name: "Add someone", exact: true }).click()
    await host.getByRole("button", { name: "Generate link", exact: true }).click()
    await ray.goto(await host.getByLabel("Pairing link").inputValue())
    const raySync = ray.getByRole("dialog", { name: "Device sync" })
    await raySync.getByRole("button", { name: "Accept and join", exact: true }).click()
    await host.getByLabel("Participant role").selectOption("editor")
    await host.getByRole("button", { name: "Approve access", exact: true }).click()
    await expect(raySync.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
    await expect(ray.getByLabel("Workspace role: editor")).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => readStoredBoardAccess(ray, workspaceId), { timeout: 30_000 }).toMatchObject({
      version: 2, mode: "write",
    })
    const initialRayAccess = await readStoredBoardAccess(ray, workspaceId)
    expect(initialRayAccess).toMatchObject({ version: 2, mode: "write" })
    expect(initialRayAccess.personId).toBeTruthy()
    expect(initialRayAccess.subjectPersonId).toBe(initialRayAccess.personId)
    await raySync.getByRole("button", { name: "Close", exact: true }).first().click()
    if (await raySync.isVisible()) await raySync.getByRole("button", { name: "Close", exact: true }).first().click()
    if (await host.isVisible()) await host.getByRole("button", { name: "Close", exact: true }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const storage = page.getByRole("dialog", { name: "Device sync" }).getByRole("region", { name: "Rusty", exact: true })
    await storage.getByRole("button", { name: "Sync now", exact: true }).click()
    await expect(storage.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled({ timeout: 45_000 })
    await expect(storage.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
    const originalConnection = await workspaceConnectionFingerprint(page, workspaceId)
    expect(await workspaceConnectionFingerprint(ray, workspaceId)).toBe(originalConnection)

    const identityState = await managerContext.storageState({ indexedDB: true })
    identityState.origins = identityState.origins.filter(entry => entry.origin === identityOrigin)
    identityState.cookies = []
    await page.close()
    newOwnerContext = await browser.newContext({ storageState: identityState })
    await newOwnerContext.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
    const newOwner = await newOwnerContext.newPage()
    await newOwner.goto(baseURL!)
    await expect(newOwner.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
    await approveBoAppDevice(newOwner, appOrigin, ownerPersonId)
    await expect(newOwner.getByRole("button", { name: "Open Retained opportunity — Engineer", exact: true }))
      .toBeVisible({ timeout: 90_000 })
    await expect(newOwner.getByLabel("Workspace role: owner")).toBeVisible()
    expect(await newOwner.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)).toBe(workspaceId)
    const restoredOwner = await newOwner.evaluate(async () => {
      const profile = (await import("/src/state.ts")).useTincanban().getCurrentProfile()!
      return { personId: profile.identity.personId, deviceId: profile.device.deviceId }
    })
    expect(restoredOwner.personId).toBe(ownerPersonId)
    expect(restoredOwner.deviceId).not.toBe(oldOwnerDeviceId)
    expect(await workspaceConnectionFingerprint(newOwner, workspaceId)).toBe(originalConnection)
    await expect.poll(() => newOwner.evaluate(async id =>
      (await import("/src/sync/workspaceParticipants.ts")).readWorkspaceParticipants(id), workspaceId), { timeout: 30_000 })
      .toContainEqual({ personId: editorPersonId, role: "editor" })
    const scopeId = await newOwner.evaluate(async id => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const profile = await bootstrapIdentity()
      const config = (await getReplicaConfigurations(profile.identity.personId)).find(value => value.workspaceId === id)
      if (!config) throw new Error("Restored workspace has no Rusty scope")
      return config.scopeId
    }, workspaceId)
    const objectPath = `${rusty.origin}/v2/scopes/${encodeURIComponent(scopeId)}/objects**`
    const blockedObjectRequests: Array<{ method: string }> = []
    for (const context of [newOwnerContext, rayContext]) {
      await context.route(objectPath, async route => {
        const method = route.request().method()
        if (method === "GET" || method === "PUT") {
          blockedObjectRequests.push({ method })
          return route.fulfill({ status: 503, body: "Rusty board data temporarily unavailable" })
        }
        return route.continue()
      })
    }

    // Old Bo is closed. Keep Ray on its original endpoint; later edits must
    // cross the authenticated direct session rather than Rusty board storage.
    await expect(newOwner.getByLabel(/^Devices connected/u)).toBeVisible({ timeout: 45_000 })
    await expect(ray.getByLabel(/^Devices connected/u)).toBeVisible({ timeout: 45_000 })
    await addLead(newOwner, "Bo edit after owner recovery")
    await expect(ray.getByRole("button", { name: "Open Bo edit after owner recovery — Engineer", exact: true }))
      .toBeVisible({ timeout: 45_000 })
    // Failed inventory prevents upload from starting; the observed read proves Rusty delivery is unavailable.
    await expect.poll(() => blockedObjectRequests.filter(request => request.method === "GET").length,
      { timeout: 45_000 }).toBeGreaterThan(0)
    await addLead(ray, "Ray edit after owner recovery")
    await expect(newOwner.getByRole("button", { name: "Open Ray edit after owner recovery — Engineer", exact: true }))
      .toBeVisible({ timeout: 45_000 })
    // Older releases copied the workspace secret into route records. A retained
    // route can outlive that copy; the signed handshake uses current board access.
    await newOwner.evaluate(async id => {
      const { peerStore } = await import("/src/sync/peerStore.ts")
      const peers = await peerStore.listPeers(id)
      const editor = peers.find(peer => peer.role === "editor")
      if (!editor) throw new Error("Recovered editor route is unavailable")
      await peerStore.upsertPeer({ ...editor, transportSecret: "obsolete-route-cache", lastSeen: new Date().toISOString() })
      if ((await peerStore.getPeer(id, editor.deviceId))?.transportSecret !== "obsolete-route-cache") {
        throw new Error("Legacy route fixture was not retained")
      }
    }, workspaceId)
    await newOwner.reload()
    await expect(newOwner.getByRole("button", { name: "Open Retained opportunity — Engineer", exact: true }))
      .toBeVisible({ timeout: 45_000 })
    await expect(newOwner.getByRole("button", { name: "Open Bo edit after owner recovery — Engineer", exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await expect(newOwner.getByRole("button", { name: "Open Ray edit after owner recovery — Engineer", exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await expect(newOwner.getByLabel(/^Devices connected/u)).toBeVisible({ timeout: 45_000 })
    await addLead(ray, "Ray edit after legacy route reload")
    await expect(newOwner.getByRole("button", { name: "Open Ray edit after legacy route reload — Engineer", exact: true }))
      .toBeVisible({ timeout: 45_000 })
    expect(await newOwner.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id))
      .toBe(workspaceId)
  } finally {
    await Promise.allSettled([ownerContext.close(), managerContext?.close(), rayContext.close(), newOwnerContext?.close()])
    await rusty.close()
  }
})
