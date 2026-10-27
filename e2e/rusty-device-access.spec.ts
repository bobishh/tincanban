import { expect, test } from "./support/coverage"

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "webkit") await page.setViewportSize({ width: 360, height: 800 })
})

test("Given an owner has a legacy Rusty permission, when device access is updated, then connection stays and legacy notice clears", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess())
  await page.locator(".rusty-connection").click()
  await expect(page.getByRole("region", { name: "Rusty", exact: true }).getByRole("status")).toHaveText("Access required")
  await page.getByRole("button", { name: "Update access" }).click()

  await expect(page.getByRole("button", { name: "Update access" })).toHaveCount(0)
  await expect(page.getByRole("region", { name: "Rusty" }).locator(".rusty-connections").first()
    .getByText("https://rusty.example", { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.rustyDeviceAccessFixture?.calls)).toEqual([
    { origin: "https://rusty.example", workspaceId: "board" },
  ])
})

test("Given device access update is pending, when owner starts it, then show disabled progress action", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("pending"))
  const action = page.getByRole("button", { name: "Update access" })
  await page.locator(".rusty-connection").click()
  await action.click()
  const pending = page.getByRole("button", { name: "Updating…" })
  await expect(pending).toBeVisible()
  await expect(pending).toBeDisabled()
  expect(await page.evaluate(() => window.rustyDeviceAccessFixture?.calls)).toHaveLength(1)

  await page.evaluate(() => window.rustyDeviceAccessFixture?.resolvePending?.())
  await expect(page.getByRole("button", { name: "Updating…" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Update access" })).toHaveCount(0)
})

test("Given device access update fails, when owner retries, then keep action and report failure", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("failure"))
  await page.locator(".rusty-connection").click()
  await page.getByRole("button", { name: "Update access" }).click()

  await expect(page.getByRole("alert")).toContainText("Device access update failed")
  await expect(page.getByRole("button", { name: "Update access" })).toBeEnabled()
  expect(await page.evaluate(() => window.rustyDeviceAccessFixture?.calls)).toHaveLength(1)
})

test("Given a non-owner sees a legacy Rusty permission, when opening Rusty, then hide owner device-access controls", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("success", false))

  await expect(page.getByRole("button", { name: "Update access" })).toHaveCount(0)
  await expect(page.getByText("Allow your approved devices to manage this Rusty connection. Your boards and saved files stay unchanged.")).toHaveCount(0)
})

test("Given conflicting board credentials, when Rusty loads, then say connection is paused and retained without showing secrets", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("success", true, [
    { origin: "https://rusty.example", scopeId: "secret-scope-id", workspaceIds: ["board"], identityState: false },
  ]))

  await page.locator(".rusty-connection").click()
  const alert = page.getByRole("alert", { name: "Rusty settings conflict" })
  await expect(alert).toContainText("Connection paused")
  await expect(alert).toContainText("Saved changes are retained")
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

  await page.locator(".rusty-connection").click()
  const alert = page.getByRole("alert", { name: "Rusty settings conflict" })
  await expect(alert).toContainText("Connection paused")
  await expect(alert).toContainText("Saved changes are retained")
  await expect(alert).toContainText("Every previous key and saved upload stays available")
  await expect(alert.getByRole("button", { name: "Recover connection" })).toBeVisible()
  const panelText = await page.getByRole("region", { name: "Rusty", exact: true }).innerText()
  expect(panelText).not.toContain("secret-identity-scope")
  expect(panelText).not.toContain("content-key")
})

test("Given an identity-only credential recovery, when Rusty opens on a workspace without a board connection, then keep recovery visible", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("success", true, [
    { origin: "https://rusty.example", scopeId: "secret-identity-scope", workspaceIds: [], identityState: true },
  ], "identity"))

  await page.locator(".rusty-connection").click()
  const alert = page.getByRole("alert", { name: "Rusty settings conflict" })
  await expect(alert).toContainText("Connection paused")
  await expect(alert.getByRole("button", { name: "Recover connection" })).toBeVisible()
})

test("Given identity recovery with no active connections, when Rusty opens, then keep recovery visible", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("success", true, [
    { origin: "https://rusty.example", scopeId: "secret-identity-scope", workspaceIds: [], identityState: true },
  ], "none"))

  await page.locator(".rusty-connection").click()
  const alert = page.getByRole("alert", { name: "Rusty settings conflict" })
  await expect(alert).toContainText("Connection paused")
  await expect(alert.getByRole("button", { name: "Recover connection" })).toBeVisible()
})

test("Given board and identity recoveries share an origin, when Rusty opens one workspace, then retain matching conflicts and hide another board's conflict", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("success", true, [
    { origin: "https://rusty.example", scopeId: "board-scope-id", workspaceIds: ["board"], identityState: false },
    { origin: "https://rusty.example", scopeId: "identity-scope-id", workspaceIds: [], identityState: true },
    { origin: "https://rusty.example", scopeId: "other-board-scope-id", workspaceIds: ["other-board"], identityState: false },
  ], "board-and-identity"))

  await expect(page.locator(".rusty-connection")).toHaveCount(1)
  await expect(page.getByRole("region", { name: "Rusty", exact: true }).getByRole("status")).toHaveText("Settings conflict")
  await page.locator(".rusty-connection").click()
  await expect(page.getByRole("alert", { name: "Rusty settings conflict" })).toHaveCount(2)
  await expect(page.getByRole("button", { name: "Recover connection", exact: true })).toHaveCount(2)
})

for (const delivery of ["synced", "unavailable", "pending"] as const) test(`Given one Rusty serves this board and Identity, when ${delivery}, then show one compact status and disclose its address`, async ({ page }, info) => {
  await page.goto("/")
  await page.evaluate(async delivery => (await import("/e2e/support/rustyDeviceAccess.ts"))
    .mountRustyDeviceAccess("success", true, [], "board-and-identity", delivery), delivery)
  const panel = page.getByRole("region", { name: "Rusty", exact: true })
  await expect(panel.locator(".rusty-connection")).toHaveCount(1)
  await expect(panel.getByRole("status")).toHaveText({ synced: "Synced", unavailable: "Unavailable", pending: "Syncing" }[delivery])
  await expect(panel.getByText("https://rusty.example", { exact: true })).not.toBeVisible()
  await expect(panel.getByText("Profile photo and settings", { exact: true })).toHaveCount(0)
  await page.screenshot({ animations: "disabled", path: info.outputPath(`rusty-${delivery}.png`) })
  await panel.locator(".rusty-connection").click()
  await expect(panel.getByText("https://rusty.example", { exact: true })).toBeVisible()
  if (delivery === "unavailable") await expect(panel.getByRole("alert")).toHaveText("Server unavailable")
  await panel.locator(".rusty-connection").click()
  await expect(panel.getByText("https://rusty.example", { exact: true })).not.toBeVisible()
})
