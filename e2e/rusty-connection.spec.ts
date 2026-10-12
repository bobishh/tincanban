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
    await page.getByRole("tab", { name: "Rusty", exact: true }).click()
    const panel = page.getByRole("region", { name: "Rusty", exact: true })
    await expect(panel).toHaveCount(1)
    await expect(page.getByRole("heading", { name: /Blind Rusty|Keepers/ })).toHaveCount(0)
    await expect(page.getByLabel("Operator token")).toHaveCount(0)
    await expect(page.getByRole("button", { name: /private.*access/i })).toHaveCount(0)
    await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await panel.getByLabel("Address", { exact: true }).fill(origin)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(panel.getByText("Synced", { exact: true })).toBeVisible()
    await expect(panel.getByText(/^Last sync:/)).toBeVisible()
    await expect(page.locator(".brand-mark")).toHaveClass(/is-connected/)
    await expect(page.locator(".brand-mark")).toHaveAttribute("title", /Rusty synced at/)
    await expectFaviconColor(page, "#69db7c")
    await expect(panel.getByLabel("Address", { exact: true })).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath("rusty-connected.png") })
    const [scope] = await readdir(join(directory, "scopes"))
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
    await stop()
    await panel.getByRole("button", { name: "Sync now", exact: true }).click()
    await expect(panel.getByText("Unavailable", { exact: true })).toBeVisible()
    await expect(panel.getByText(/^Last sync:/)).toBeVisible()
    await expect(page.locator(".brand-mark")).toHaveClass(/is-offline/)
    await expect(page.locator(".brand-mark")).toHaveAttribute("title", /Rusty unavailable/)
    await expectFaviconColor(page, "#ff5a36")
    await panel.getByRole("button", { name: "Remove", exact: true }).click()
    await expect(panel.getByText("Removal pending", { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath("rusty-removal-pending.png") })
    await page.reload()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await page.getByRole("tab", { name: "Rusty", exact: true }).click()
    await expect(panel.getByText("Removal pending", { exact: true })).toBeVisible()
    await start(new URL(origin).host)
    await panel.getByRole("button", { name: "Retry removal", exact: true }).click()
    await expect(panel.getByText(origin, { exact: true })).toHaveCount(0)
    expect(JSON.parse(await readFile(join(directory, "scopes", scope!, "policy.json"), "utf8")).revoked).toBe(true)
    await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    await expect(page.getByRole("region", { name: "Preserved Jobs", exact: true })).toBeVisible()
  } finally {
    if (child && child.exitCode === null) await stop()
    await rm(directory, { recursive: true, force: true })
  }
})
