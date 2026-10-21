import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"
import { startRustyService } from "./support/rustyService"

test.use({ browserName: process.platform === "darwin" ? "webkit" : "chromium",
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

test("Given a phone with conflicting Rusty credentials, when snapshot confirmation fails and the owner retries after reload, then finish the saved transition and retain the board", async ({ page, baseURL }) => {
  test.setTimeout(90_000)
  await page.goto("/")
  await createJobSearchWorkspace(page, "Retained phone board")
  const owner = await page.evaluate(async () => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const profile = await bootstrapIdentity()
    return { identity: profile.identity, allowedControllerDeviceIds: [profile.device.deviceId] }
  })
  const rusty = await startRustyService(owner, baseURL!)
  let releaseProfileRead: (() => void) | undefined
  const openRusty = async () => {
    await page.getByRole("button", { name: "Menu", exact: true }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()

  }
  try {
    await openRusty()
    const panel = page.getByRole("region", { name: "Rusty", exact: true })
    await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await panel.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(panel.locator(".rusty-connections").first().getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(panel.getByRole("button", { name: "Sync now", exact: true })).toBeEnabled()
    const original = await page.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const repository = await import("/src/sync/privateReplicaRepository.ts")
      const { emptyPrivateReplicaState, changeReplicaPreference, portableReplicaState } = await import("/src/sync/privateReplicaPreferences.ts")
      const { identityDevicePreferencesChanged } = await import("/src/sync/identityDevicePreferenceEvents.ts")
      const personId = (await bootstrapIdentity()).identity.personId
      const config = (await repository.getReplicaConfigurations(personId)).find(value => value.origin === origin)!
      const profileScope = (await repository.getPrivateReplicaConfigurations(personId)).find(value => value.origin === origin && value.purpose === "identity")!.scopeId
      const competing = changeReplicaPreference(emptyPrivateReplicaState(personId, "offline-device"), {
        ...config, contentKey: "B".repeat(42) + "A",
      })
      await repository.receivePrivateReplicaState(personId, portableReplicaState(competing))
      identityDevicePreferencesChanged(personId)
      return { personId, profileScope, keyEpoch: config.keyEpoch, contentKey: config.contentKey, scopeId: config.scopeId }
    }, rusty.origin)
    const conflict = page.getByRole("alert", { name: "Rusty settings conflict", exact: true })
    await expect(conflict).toBeVisible()
    const uploads = `${rusty.origin}/v2/scopes/${original.scopeId}/objects/**`
    let blockedUploads = 0
    await page.route(uploads, async route => {
      if (route.request().method() === "PUT") { blockedUploads++; await route.fulfill({ status: 503, body: JSON.stringify({ message: "Snapshot confirmation unavailable" }) }) }
      else await route.continue()
    })
    const profileRead = new Promise<void>(resolve => { releaseProfileRead = resolve })
    let profileReadHeld = false
    await page.route(url => url.origin === rusty.origin && url.pathname === `/v2/scopes/${original.profileScope}/objects`, async route => {
      if (!profileReadHeld && route.request().method() === "GET") { profileReadHeld = true; await profileRead }
      await route.continue()
    })
    await page.evaluate(async personId => (await import("/src/sync/identityDevicePreferenceEvents.ts")).identityDevicePreferencesChanged(personId), original.personId)
    await expect.poll(() => profileReadHeld).toBe(true)
    await conflict.getByRole("button", { name: "Recover connection", exact: true }).tap()
    await expect(conflict.getByRole("button", { name: "Recovering connection…", exact: true })).toBeVisible()
    expect(blockedUploads).toBe(0)
    releaseProfileRead!()
    await expect(conflict.getByRole("alert")).toContainText("Snapshot confirmation unavailable", { timeout: 30_000 })
    await expect(conflict.getByRole("button", { name: "Recover connection", exact: true })).toBeEnabled()
    await page.reload()
    await openRusty()
    await expect(conflict).toBeVisible()
    await page.unroute(uploads)
    await conflict.getByRole("button", { name: "Recover connection", exact: true }).tap()
    await expect(conflict).toHaveCount(0, { timeout: 30_000 })
    await expect(panel.locator(".rusty-connections").first().getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    const restored = await page.evaluate(async () => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      return (await getReplicaConfigurations((await bootstrapIdentity()).identity.personId))[0]!
    })
    expect(restored.scopeId).toBe(original.scopeId)
    expect(restored.keyEpoch).toBe(original.keyEpoch + 1)
    expect(JSON.stringify(restored)).toContain(original.contentKey)
    await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    await expect(page.getByRole("region", { name: "Retained phone board", exact: true })).toBeVisible()
  } finally { releaseProfileRead?.(); await rusty.close() }
})
