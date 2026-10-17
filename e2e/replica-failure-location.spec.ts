import { expect, test } from "./support/coverage"

test.use({ viewport: { width: 390, height: 844 } })

test("Given local replica persistence fails, when Device sync opens, then explain the device problem outside Rusty and allow a successful retry", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/replicaFailure.ts")).mountReplicaFailure("local"))
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  const rusty = dialog.getByRole("region", { name: "Rusty", exact: true })
  const issue = dialog.getByRole("region", { name: "Device sync problem" })
  await expect(issue).toContainText("Board sync paused on this device")
  await expect(rusty).not.toContainText("Unavailable")
  await expect(rusty).not.toContainText("generation")
  await expect(rusty.getByRole("alert")).toHaveCount(0)
  await expect(dialog).not.toContainText("Replica progress generation changed during persistence")
  await issue.getByRole("button", { name: "Retry sync" }).click()
  await expect(issue).toHaveCount(0)
  await expect(rusty.getByText("Synced", { exact: true }).first()).toBeVisible()
})

test("Given a Rusty network request fails, when Device sync opens, then show a safe connection error under the server and no local device problem", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/replicaFailure.ts")).mountReplicaFailure("network"))
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  const rusty = dialog.getByRole("region", { name: "Rusty", exact: true })
  await expect(rusty).toContainText("Unavailable")
  await expect(rusty.getByRole("alert")).toContainText("Rusty connection unavailable. Retry sync.")
  await expect(dialog.getByRole("region", { name: "Device sync problem" })).toHaveCount(0)
  await expect(dialog).not.toContainText("raw-private-transport-detail")
})
