import { expect, test } from "./support/coverage"

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "webkit") await page.setViewportSize({ width: 360, height: 800 })
})

test("Given an owner has a legacy Rusty permission, when device access is updated, then connection stays and legacy notice clears", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess())
  await expect(page.getByText("Allow your approved devices to manage this Rusty connection. Your boards and saved files stay unchanged.")).toBeVisible()
  await page.getByRole("button", { name: "Update device access" }).click()

  await expect(page.getByRole("button", { name: "Update device access" })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Rusty" }).locator(".rusty-connections").first()
    .getByText("https://rusty.example", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.rustyDeviceAccessFixture?.calls)).toEqual([
    { origin: "https://rusty.example", workspaceId: "board" },
  ])
})

test("Given device access update is pending, when owner starts it, then show disabled progress action", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("pending"))
  const action = page.getByRole("button", { name: "Update device access" })
  await action.click()
  const pending = page.getByRole("button", { name: "Updating device access…" })
  await expect(pending).toBeVisible()
  await expect(pending).toBeDisabled()
  expect(await page.evaluate(() => window.rustyDeviceAccessFixture?.calls)).toHaveLength(1)

  await page.evaluate(() => window.rustyDeviceAccessFixture?.resolvePending?.())
  await expect(page.getByRole("button", { name: "Updating device access…" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Update device access" })).toHaveCount(0)
})

test("Given device access update fails, when owner retries, then keep action and report failure", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("failure"))
  await page.getByRole("button", { name: "Update device access" }).click()

  await expect(page.getByRole("alert")).toContainText("Device access update failed")
  await expect(page.getByRole("button", { name: "Update device access" })).toBeEnabled()
  expect(await page.evaluate(() => window.rustyDeviceAccessFixture?.calls)).toHaveLength(1)
})

test("Given a non-owner sees a legacy Rusty permission, when opening Rusty, then hide owner device-access controls", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("success", false))

  await expect(page.getByRole("button", { name: "Update device access" })).toHaveCount(0)
  await expect(page.getByText("Allow your approved devices to manage this Rusty connection. Your boards and saved files stay unchanged.")).toHaveCount(0)
})

test("Given conflicting board credentials, when Rusty loads, then say connection is paused and retained without showing secrets", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("success", true, [
    { origin: "https://rusty.example", scopeId: "secret-scope-id", workspaceIds: ["board"], identityState: false },
  ]))

  const alert = page.getByRole("alert", { name: "Rusty settings conflict" })
  await expect(alert).toContainText("devices saved different connection settings")
  await expect(alert).toContainText("saved changes are retained")
  await expect(alert).toContainText("Every previous key and saved upload stays available")
  await expect(alert.getByRole("button", { name: "Recover connection" })).toBeVisible()
  const panelText = await page.getByRole("region", { name: "Rusty", exact: true }).innerText()
  for (const secret of ["secret-scope-id", "board-scope", "service-key", "read-token", "write-token", "content-key"]) {
    expect(panelText).not.toContain(secret)
  }
})

test("Given conflicting profile credentials for a connected origin, when Rusty loads, then explain profile delivery is paused", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("success", true, [
    { origin: "https://rusty.example", scopeId: "secret-identity-scope", workspaceIds: [], identityState: true },
  ]))

  const alert = page.getByRole("alert", { name: "Rusty profile settings conflict" })
  await expect(alert).toContainText("Profile delivery is paused")
  await expect(alert).toContainText("saved changes are retained")
  await expect(alert).toContainText("Every previous key and saved upload stays available")
  await expect(alert.getByRole("button", { name: "Recover connection" })).toBeVisible()
  const panelText = await page.getByRole("region", { name: "Rusty", exact: true }).innerText()
  expect(panelText).not.toContain("secret-identity-scope")
  expect(panelText).not.toContain("content-key")
})
