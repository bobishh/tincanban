import { expect, test } from "@playwright/test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expectFaviconColor } from "./support/favicon"
import { createJobSearchWorkspace } from "./support/workspaces"
import { startRustyService } from "./support/rustyService"
import { approveRustyForFixture } from "./support/identityRustyFixture"

test("Given connected private board storage, when approving inspection from Rusty, then show its checked status without credentials and retain an actionable access failure", async ({ page, context, baseURL }, info) => {
  test.setTimeout(90_000)
  await page.goto("/")
  await createJobSearchWorkspace(page, "Storage inspection board")
  const rusty = await startRustyService({}, baseURL!)
  const service = await context.newPage()
  try {
    await approveRustyForFixture(page, rusty.origin)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const panel = page.getByRole("region", { name: "Rusty", exact: true })
    await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await panel.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    const secrets = await page.evaluate(async () => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getPrivateReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      return (await getPrivateReplicaConfigurations((await bootstrapIdentity()).identity.personId))
        .flatMap(config => [config.readToken, config.writeToken, config.contentKey]).filter(Boolean)
    })
    await service.goto(rusty.origin)
    await service.evaluate(() => {
      const replies: unknown[] = []
      Object.assign(window, { statusReplies: replies })
      window.addEventListener("message", event => { if (event.data?.type === "rusty-status@1") replies.push(event.data) })
    })
    await expect(service.getByText("Storage available", { exact: true })).toBeVisible()
    const approvalEvent = service.waitForEvent("popup")
    await service.getByRole("button", { name: "View my boards", exact: true }).click()
    const approval = await approvalEvent
    const confirmation = approval.getByRole("dialog", { name: "View board storage status" })
    await expect(confirmation.getByText("Storage inspection board", { exact: true })).toBeVisible()
    await expect(service.getByRole("article", { name: "Storage inspection board" })).toHaveCount(0)
    await confirmation.getByRole("button", { name: "Share board status", exact: true }).click()
    const board = service.getByRole("article", { name: "Storage inspection board" })
    await expect(board.getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    const boardId = new URL(page.url()).pathname.split("/")[2]!
    await expect(board.getByRole("link", { name: "Open board", exact: true })).toHaveAttribute("href", `${baseURL}/boards/${boardId}`)
    await expect(service.getByText(/Checked from this browser/)).toBeVisible()
    await service.screenshot({ path: info.outputPath("rusty-board-status.png"), fullPage: true })
    await context.route(`${rusty.origin}/v2/scopes/**`, async route => {
      if (route.request().method() === "GET") await route.fulfill({ status: 403, body: JSON.stringify({ message: "Access revoked for this test" }) })
      else await route.continue()
    })
    const retryEvent = service.waitForEvent("popup")
    await service.getByRole("button", { name: "Refresh board status", exact: true }).click()
    const retry = await retryEvent
    await retry.getByRole("button", { name: "Share board status", exact: true }).click()
    await expect(board.getByText("Access required", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(board.getByText(/owner.*Sync/i)).toBeVisible()
    await service.screenshot({ path: info.outputPath("rusty-board-status-access-required.png"), fullPage: true })
    const replies = await service.evaluate(() => JSON.stringify((window as unknown as { statusReplies: unknown[] }).statusReplies))
    expect(JSON.parse(replies)).toHaveLength(2)
    expect(replies).not.toMatch(/readToken|writeToken|contentKey/)
    for (const secret of secrets) expect(replies).not.toContain(secret)
    const reopened = await context.newPage()
    await reopened.goto((await board.getByRole("link", { name: "Open board", exact: true }).getAttribute("href"))!)
    await expect(reopened.getByRole("heading", { name: /TINCANBAN.*Storage inspection board/ })).toBeVisible()
    await expect(reopened.getByRole("heading", { name: "Board unavailable", exact: true })).toHaveCount(0)
    await reopened.close()
  } finally { await service.close(); await rusty.close() }
})

test("Given an owned board, address-only Rusty connects once and removal waits for server revocation without losing local work", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90000)
  await page.goto("/")
  await createJobSearchWorkspace(page, "Preserved Jobs")
  const directory = await mkdtemp(join(tmpdir(), "rusty-connect-"))
  let child: ChildProcess | undefined
  const start = async (bind = "127.0.0.1:0") => new Promise<string>((resolveOrigin, reject) => {
    child = spawn(resolve(process.env.TINCANBAN_RUSTY_BINARY ?? "../mesh-lighthouse/target/debug/mesh-lighthouse"), [directory, bind], {
      env: { RUSTY_CORS_ORIGINS: baseURL! },
    })
    const timer = setTimeout(() => reject(new Error("Rusty did not start")), 10000)
    child.stdout?.on("data", chunk => { const address = String(chunk).match(/listening on (127\.0\.0\.1:\d+)/)?.[1]; if (address) { clearTimeout(timer); resolveOrigin(`http://${address}`) } })
    child.once("error", reject)
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Rusty exited ${code}`)) })
  })
  const stop = async () => { const current = child!; const exited = new Promise<void>(done => current.once("exit", () => done())); current.kill("SIGTERM"); await exited; child = undefined }
  try {
    const origin = await start()
    await approveRustyForFixture(page, origin)
    await page.getByRole("button", { name: "Sync", exact: true }).click()

    const panel = page.getByRole("region", { name: "Rusty", exact: true })
    await expect(panel).toHaveCount(1)
    await expect(page.getByRole("heading", { name: /Blind Rusty|Keepers/ })).toHaveCount(0)
    await expect(page.getByLabel("Operator token")).toHaveCount(0)
    await expect(page.getByRole("button", { name: /private.*access/i })).toHaveCount(0)
    await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await panel.getByLabel("Address", { exact: true }).fill(origin)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText(/^Last sync:/)).toBeVisible()
    await expect(page.locator(".brand-mark")).toHaveClass(/is-connected/)
    await expect(page.locator(".brand-mark")).toHaveAttribute("title", /Rusty synced at/)
    await expectFaviconColor(page, "#69db7c")
    await expect(panel.getByLabel("Address", { exact: true })).toBeHidden()
    await page.setViewportSize({ width: 1600, height: 1100 })
    const syncWindow = page.getByRole("dialog", { name: "Device sync" })
    await syncWindow.getByRole("button", { name: "Maximize window", exact: true }).click()
    await expect.poll(async () => (await syncWindow.boundingBox())!.width).toBeGreaterThan(1500)
    await page.screenshot({ path: testInfo.outputPath("rusty-connected.png") })
    const scope = await page.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const configs = await getReplicaConfigurations((await bootstrapIdentity()).identity.personId)
      const config = configs.find(value => value.origin === origin)
      if (!config) throw new Error("Rusty workspace access missing")
      return config.scopeId
    }, origin)
    const files = await readdir(join(directory, "scopes", scope!, "objects"))
    expect(files.length).toBeGreaterThan(0)
    // Given unchanged board and chat, repeated polling must not append full copies.
    const syncButton = panel.getByRole("button", { name: "Sync now", exact: true })
    await expect(syncButton).toBeEnabled()
    for (let pass = 0; pass < 3; pass++) {
      await syncButton.click()
      await expect(syncButton).toBeDisabled()
      await expect(syncButton).toBeEnabled()
    }
    expect(await readdir(join(directory, "scopes", scope!, "objects"))).toHaveLength(files.length)
    const object = JSON.parse(await readFile(join(directory, "scopes", scope!, "objects", files[0]!), "utf8"))
    expect(Object.keys(object.object).sort()).toEqual(["ciphertext", "keyEpoch", "nonce", "scopeId", "version"])
    expect(JSON.stringify(object)).not.toContain("Preserved Jobs")
    // Given eight encrypted, signed snapshots, owner polling replaces their retained prefix once.
    await page.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const { decryptBlindObject, decodeBlindBytes, encryptBlindObject } = await import("/@id/@meta-uber/mesh-replication/rusty-replica")
      const { inventoryBlindObjects, downloadBlindObject, uploadBlindObject } = await import("/src/sync/blindClient.ts")
      const profile = await bootstrapIdentity()
      const configs = await getReplicaConfigurations(profile.identity.personId)
      const config = configs.find(value => value.origin === origin)
      if (!config) throw new Error("Rusty workspace access missing")
      const inventory = await inventoryBlindObjects(config, 0)
      const stored = await downloadBlindObject(config, inventory.objects[0]!.objectId)
      const plaintext = await decryptBlindObject(stored, config.scopeId, config.keyEpoch, decodeBlindBytes(config.contentKey))
      for (let copy = 1; copy < 8; copy++) await uploadBlindObject(config, await encryptBlindObject(config.scopeId, config.keyEpoch, decodeBlindBytes(config.contentKey), plaintext))
    }, origin)
    await syncButton.click()
    await expect(syncButton).toBeEnabled()
    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
    expect(await readdir(join(directory, "scopes", scope!, "objects"))).toHaveLength(1)
    const descriptor = await (await page.request.get(`${origin}/.well-known/mesh-lighthouse`)).json()
    expect(descriptor.capabilities.snapshotCheckpoints.version).toBe(1)
    // A reloaded client behind the compacted prefix admits the replacement through the native path.
    await page.evaluate(async ({ origin, scope }) => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { updateLocal } = await import("/src/localDb.ts")
      const profile = await bootstrapIdentity()
      const key = `tincanban.private-replica-state.v2.${profile.identity.personId}`
      await updateLocal(key, raw => {
        if (!raw) throw new Error("Private replica repository missing")
        const state = JSON.parse(raw) as { progress: Record<string, unknown> }
        // Simulate this workspace's fresh local cursor without changing portable preferences or other scopes.
        delete state.progress[`${origin}/${scope}`]
        return JSON.stringify(state)
      })
    }, { origin, scope })
    await page.reload()
    await page.getByRole("button", { name: "Sync", exact: true }).click()

    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
    expect(await readdir(join(directory, "scopes", scope!, "objects"))).toHaveLength(1)
    await stop()
    await panel.getByRole("button", { name: "Sync now", exact: true }).click()
    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText("Unavailable", { exact: true })).toBeVisible()
    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText(/^Last sync:/)).toBeVisible()
    await expect(page.locator(".brand-mark")).toHaveClass(/is-offline/)
    await expect(page.locator(".brand-mark")).toHaveAttribute("title", /Rusty unavailable/)
    await expectFaviconColor(page, "#ff5a36")
    await panel.getByRole("button", { name: "Remove", exact: true }).click()
    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText("Removal pending", { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("rusty-removal-pending.png") })
    await page.reload()
    await page.getByRole("button", { name: "Sync", exact: true }).click()

    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText("Removal pending", { exact: true })).toBeVisible()
    // Given an operator reset preserving service identity, stale connections remain removable.
    const serviceKey = await readFile(join(directory, "service-key"))
    await rm(join(directory, "scopes"), { recursive: true, force: true })
    await rm(join(directory, "enrollment"), { recursive: true, force: true })
    await start(new URL(origin).host)
    expect(await readFile(join(directory, "service-key"))).toEqual(serviceKey)
    // Reload resumes the pending revocation; its background retry can finish before a manual click.
    await expect(panel.getByText(origin, { exact: true })).toHaveCount(0, { timeout: 30_000 })
    expect(JSON.parse(await readFile(join(directory, "scopes", scope!, "policy.json"), "utf8")).revoked).toBe(true)
    // When the owner reconnects by address, a fresh scope stores the preserved local board.
    await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await panel.getByLabel("Address", { exact: true }).fill(origin)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
    const newScope = (await readdir(join(directory, "scopes"))).find(value => value !== scope)
    expect(newScope).toBeTruthy()
    expect((await readdir(join(directory, "scopes", newScope!, "objects"))).length).toBeGreaterThan(0)
    // Given an operator erases server storage, explicitly abandon frozen local intent before adding fresh scopes.
    await expect(syncButton).toBeEnabled()
    const beforeReset = await page.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getPrivateReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const { prepareReplicaCredentialFreeze } = await import("/src/sync/replicaCredentialFreeze.ts")
      const { writeLocal } = await import("/src/localDb.ts")
      const profile = await bootstrapIdentity()
      const configs = (await getPrivateReplicaConfigurations(profile.identity.personId)).filter(config => config.origin === origin)
      await prepareReplicaCredentialFreeze(profile, origin, configs[0]!.servicePublicKey, "retired-test-device", () => {})
      const removalKey = `tincanban.my-device-removals.v1.${profile.identity.personId}`
      const removalRaw = JSON.stringify([{ version: 1, personId: profile.identity.personId, signerDeviceId: profile.device.deviceId,
        deviceId: "retired-test-device", name: "Retired test device", workspaces: {}, origins: { [origin]: { status: "pending", error: "Old epoch" } } }])
      await writeLocal(removalKey, removalRaw)
      return { personId: profile.identity.personId, deviceId: profile.device.deviceId, scopes: configs.map(config => config.scopeId), removalKey, removalRaw }
    }, origin)
    await stop()
    for (const entry of await readdir(directory)) if (entry !== "service-key") await rm(join(directory, entry), { recursive: true, force: true })
    await panel.getByRole("button", { name: "Forget Rusty on this device", exact: true }).click()
    await panel.getByRole("button", { name: "Cancel", exact: true }).click()
    expect(await page.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { readReplicaCredentialFreeze } = await import("/src/sync/replicaCredentialFreeze.ts")
      return Boolean(await readReplicaCredentialFreeze((await bootstrapIdentity()).identity.personId, origin))
    }, origin)).toBe(true)
    expect(await page.evaluate(async key => (await import("/src/localDb.ts")).readLocal(key), beforeReset.removalKey)).toBe(beforeReset.removalRaw)
    await panel.getByRole("button", { name: "Forget Rusty on this device", exact: true }).click()
    await panel.getByRole("button", { name: "Confirm forget Rusty", exact: true }).click()
    await expect(panel.getByLabel("Address", { exact: true })).toHaveValue(origin)
    await expect(panel.getByRole("button", { name: "Resume Rusty operation", exact: true })).toHaveCount(0)
    expect(await page.evaluate(async key => JSON.parse((await (await import("/src/localDb.ts")).readLocal(key))!), beforeReset.removalKey)).toEqual([])
    expect(await page.evaluate(async ({ key, raw }) => {
      const { listLocalKeys, readLocal } = await import("/src/localDb.ts")
      for (const archive of (await listLocalKeys()).filter(value => value.startsWith("tincanban.rusty-local-reset.v1."))) {
        const saved = JSON.parse((await readLocal(archive))!) as { records: Array<{ key: string; value: string | null }> }
        if (saved.records.some(record => record.key === key && record.value === raw)) return true
      }
      return false
    }, { key: beforeReset.removalKey, raw: beforeReset.removalRaw })).toBe(true)
    const afterForget = await page.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getPrivateReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const profile = await bootstrapIdentity()
      return (await getPrivateReplicaConfigurations(profile.identity.personId))
        .filter(config => config.origin === origin).map(({ purpose, scopeId }) => ({ purpose, scopeId }))
    }, origin)
    expect(afterForget).toEqual([])
    await start(new URL(origin).host)
    expect(await readFile(join(directory, "service-key"))).toEqual(serviceKey)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    await page.waitForTimeout(2000)
    const reconnectScopes = await page.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getPrivateReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const profile = await bootstrapIdentity()
      return (await getPrivateReplicaConfigurations(profile.identity.personId)).filter(config => config.origin === origin)
        .map(({ purpose, scopeId }) => ({ purpose, scopeId }))
    }, origin)
    expect(reconnectScopes.every(config => !beforeReset.scopes.includes(config.scopeId))).toBe(true)
    await expect(panel.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true }))
      .toBeVisible({ timeout: 30_000 })
    const afterReset = await page.evaluate(async origin => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const { getPrivateReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
      const profile = await bootstrapIdentity()
      const configs = (await getPrivateReplicaConfigurations(profile.identity.personId)).filter(config => config.origin === origin)
      return { personId: profile.identity.personId, deviceId: profile.device.deviceId, scopes: configs.map(config => config.scopeId), purposes: configs.map(config => config.purpose).sort() }
    }, origin)
    expect(afterReset.personId).toBe(beforeReset.personId)
    expect(afterReset.deviceId).toBe(beforeReset.deviceId)
    expect(afterReset.purposes).toEqual(["identity", "workspace"])
    expect(afterReset.scopes.every(scope => !beforeReset.scopes.includes(scope))).toBe(true)
    for (const scope of afterReset.scopes) expect((await readdir(join(directory, "scopes", scope, "objects"))).length).toBeGreaterThan(0)
    await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    await expect(page.getByRole("region", { name: "Preserved Jobs", exact: true })).toBeVisible()
  } finally {
    if (child && child.exitCode === null) await stop()
    await rm(directory, { recursive: true, force: true })
  }
})
