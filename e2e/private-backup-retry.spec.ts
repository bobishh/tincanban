import { expect, test } from "./support/coverage"
import { downloadPrivateWorkspaceRecovery } from "./support/workspaceRecoveryDownload"

test.use({ trace: "off" })

for (const stale of [true, false]) {
  test(`Given ${stale ? 'authority changes during private backup creation' : 'private backup permission is revoked'}, when exporting, then ${stale ? 'retry a fresh capture and download' : 'stop without retrying the denied operation'}`, async ({ page }) => {
    const message = stale ? "Workspace signing authority is stale" : "Workspace signing permission is revoked or conflicting"
    await page.route("**/src/app/workspaceHistoryRecovery.ts", async route => {
      const response = await route.fetch(), source = await response.text()
      const marker = "const profile = core.tincanban.getCurrentProfile();"
      expect(source).toContain(marker)
      const gate = `globalThis.__privateBackupAttempts = (globalThis.__privateBackupAttempts ?? 0) + 1;
        if (${!stale} || globalThis.__privateBackupAttempts === 1) throw new Error(${JSON.stringify(message)});`
      await route.fulfill({ response, body: source.replace(marker, `${gate}${marker}`) })
    })
    await page.goto("/")
    await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const settings = page.getByRole("dialog", { name: "Settings", exact: true })
    await settings.getByRole("tab", { name: "Identity", exact: true }).click()
    const backups = settings.getByRole("region", { name: "Private workspace recovery" })
    if (stale) {
      const download = await downloadPrivateWorkspaceRecovery(page, backups)
      expect(await download.path()).toBeTruthy()
    } else {
      await expect(downloadPrivateWorkspaceRecovery(page, backups)).rejects.toThrow(message)
      await expect(backups.getByRole("alert")).toHaveText(message)
    }
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { __privateBackupAttempts: number }).__privateBackupAttempts))
      .toBe(stale ? 2 : 1)
  })
}
