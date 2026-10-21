import { expect, test } from "@playwright/test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expectFaviconColor } from "./support/favicon"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given an owned board, address-only Rusty connects once and removal waits for server revocation without losing local work", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90000)
  await page.goto("/")
  await createJobSearchWorkspace(page, "Preserved Jobs")
  const trustedOwner = await page.evaluate(async () => {
    const module = await import("/src/domain/identity.ts")
    const profile = await module.bootstrapIdentity()
    return { identity: profile.identity, allowedControllerDeviceIds: [profile.device.deviceId] }
  })
  const directory = await mkdtemp(join(tmpdir(), "rusty-connect-"))
  let child: ChildProcess | undefined
  const start = async (bind = "127.0.0.1:0") => new Promise<string>((resolveOrigin, reject) => {
    child = spawn(resolve(process.env.TINCANBAN_RUSTY_BINARY ?? "../mesh-lighthouse/target/debug/mesh-lighthouse"), [directory, bind], {
      env: { RUSTY_TRUSTED_OWNER: JSON.stringify(trustedOwner), RUSTY_CORS_ORIGINS: baseURL! },
    })
    const timer = setTimeout(() => reject(new Error("Rusty did not start")), 10000)
    child.stdout?.on("data", chunk => { const address = String(chunk).match(/listening on (127\.0\.0\.1:\d+)/)?.[1]; if (address) { clearTimeout(timer); resolveOrigin(`http://${address}`) } })
    child.once("error", reject)
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Rusty exited ${code}`)) })
  })
  const stop = async () => { const current = child!; const exited = new Promise<void>(done => current.once("exit", () => done())); current.kill("SIGTERM"); await exited; child = undefined }
  try {
    const origin = await start()
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
      const profile = await bootstrapIdentity()
      const configs = (await getPrivateReplicaConfigurations(profile.identity.personId)).filter(config => config.origin === origin)
      await prepareReplicaCredentialFreeze(profile, origin, configs[0]!.servicePublicKey, "retired-test-device", () => {})
      return { personId: profile.identity.personId, deviceId: profile.device.deviceId, scopes: configs.map(config => config.scopeId) }
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
    await panel.getByRole("button", { name: "Forget Rusty on this device", exact: true }).click()
    await panel.getByRole("button", { name: "Confirm forget Rusty", exact: true }).click()
    await expect(panel.getByLabel("Address", { exact: true })).toHaveValue(origin)
    await expect(panel.getByRole("button", { name: "Resume Rusty operation", exact: true })).toHaveCount(0)
    await start(new URL(origin).host)
    expect(await readFile(join(directory, "service-key"))).toEqual(serviceKey)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
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
