import { readFile } from "node:fs/promises"
import { expect, test } from "./support/coverage"

test("Given a saved profile and private Rusty connection, when its encrypted recovery file is restored, then keep this device and its board while recovering the complete identity state", async ({ page }) => {
  await page.goto("/")
  const before = await page.evaluate(async () => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const { recordReplicaPreference } = await import("/src/sync/identityDevicePreferences.ts")
    const { getReplicaConfigurations } = await import("/src/sync/privateReplicaRepository.ts")
    const profile = await bootstrapIdentity()
    await recordReplicaPreference(profile.identity.personId, { origin: "https://recovery-rusty.example", workspaceId: "recovery-workspace",
      scopeId: "recovery-scope", readToken: "A".repeat(43), writeToken: "B".repeat(43), contentKey: "A".repeat(43),
      servicePublicKey: profile.device.publicKey, keyEpoch: 1, policyRevision: 1, cursor: 0, lastUploaded: "" })
    return { personId: profile.identity.personId, deviceId: profile.device.deviceId, configs: await getReplicaConfigurations(profile.identity.personId) }
  })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: "Recovery backup", exact: true }).click()
  const recovery = page.getByRole("dialog", { name: "Identity recovery", exact: true })
  const downloadEvent = page.waitForEvent("download")
  await recovery.getByRole("button", { name: "Generate and download recovery file", exact: true }).click()
  const download = await downloadEvent
  const path = await download.path()
  expect(path).not.toBeNull()
  const bytes = await readFile(path!)
  const file = JSON.parse(bytes.toString("utf8")) as { kind: string; personId: string; ciphertext: string }
  expect(file.kind).toBe("tincanban-identity-device-recovery")
  expect(file.personId).toBe(before.personId)
  expect(bytes.toString("utf8")).not.toContain("recovery-rusty.example")
  const words = await recovery.locator(".recovery-words").innerText()
  await recovery.getByRole("button", { name: "Restore from backup", exact: true }).click()
  await recovery.getByRole("textbox", { name: "Recovery words", exact: true }).fill(words)
  await recovery.getByLabel("Recovery file").setInputFiles({ name: "recovery.json", mimeType: "application/json", buffer: bytes })
  await recovery.getByRole("checkbox").check()
  await Promise.all([page.waitForEvent("load"), recovery.getByRole("button", { name: "Restore identity", exact: true }).click()])
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  const after = await page.evaluate(async () => {
    const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
    return { personId: profile.identity.personId, deviceId: profile.device.deviceId,
      configs: await (await import("/src/sync/privateReplicaRepository.ts")).getReplicaConfigurations(profile.identity.personId) }
  })
  expect(after).toEqual(before)
})

test("Given malformed or oversized recovery input, when selecting the file, then explain failure and keep restore disabled without losing words or board state", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 25_000 })
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  await page.getByRole("button", { name: "Recovery backup", exact: true }).click()
  const recovery = page.getByRole("dialog", { name: "Identity recovery", exact: true })
  await recovery.getByRole("button", { name: "Restore from backup", exact: true }).click()
  const words = recovery.getByRole("textbox", { name: "Recovery words", exact: true })
  await words.fill("Keep these unsaved recovery words")
  for (const buffer of [Buffer.from("{}"), Buffer.alloc(2 * 1024 * 1024 + 1, " ")]) {
    await recovery.getByLabel("Recovery file").setInputFiles({ name: "invalid.json", mimeType: "application/json", buffer })
    await expect(recovery.getByRole("alert")).toBeVisible()
    await expect(recovery.getByRole("button", { name: "Restore identity", exact: true })).toBeDisabled()
    await expect(words).toHaveValue("Keep these unsaved recovery words")
  }
  await recovery.getByRole("button", { name: "Close", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Settings", exact: true })).toBeVisible()
})
