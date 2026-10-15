import { expect, test } from "./support/coverage"

test.beforeEach(async ({ page, browserName }) => {
  if (browserName === "webkit") await page.setViewportSize({ width: 360, height: 800 })
})

test("Given another registered device, when the owner removes its access at one Rusty origin, then all scopes are named and secrets stay hidden", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess())
  const action = page.getByRole("button", { name: "Remove Travel laptop access from all Rusty connections at https://rusty.example" })
  await expect(action).toBeVisible()
  await expect(page.getByRole("button", { name: /This device access/ })).toHaveCount(0)
  await action.click()
  await expect(page.getByRole("button", { name: /Travel laptop/ })).toHaveCount(0)
  expect(await page.evaluate(() => window.rustyDeviceAccessFixture?.revocations)).toEqual([
    { origin: "https://rusty.example", deviceId: "other-device" },
  ])
  const panel = await page.getByRole("region", { name: "Rusty" }).innerText()
  for (const secret of ["read-token", "write-token", "content-key", "service-key", "board-scope"]) expect(panel).not.toContain(secret)
})

test("Given an interrupted transition was restored from its journal, when the owner resumes, then show progress and finish removal", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("pending"))
  const action = page.getByRole("button", { name: "Resume Travel laptop access removal at https://rusty.example" })
  await action.click()
  await expect(page.getByRole("button", { name: /Removing Travel laptop access/ })).toBeDisabled()
  await page.evaluate(() => window.rustyDeviceAccessFixture?.resolvePending?.())
  await expect(page.getByRole("button", { name: /Travel laptop/ })).toHaveCount(0)
})

test("Given removal failed after creating a transition, when the owner returns, then offer resume and retain the registered device", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("failure"))
  const action = page.getByRole("button", { name: "Remove Travel laptop access from all Rusty connections at https://rusty.example" })
  await action.click()
  await expect(page.getByRole("alert")).toContainText("Device access removal pending")
  await expect(page.getByRole("button", { name: "Resume Travel laptop access removal at https://rusty.example" })).toBeEnabled()
})

test("Given a non-owner, when opening Rusty device access, then hide identity-wide removal", async ({ page }) => {
  await page.goto("/")
  await page.evaluate(async () => (await import("/e2e/support/rustyDeviceAccess.ts")).mountRustyDeviceAccess("success", false))
  await expect(page.getByRole("button", { name: /Travel laptop access/ })).toHaveCount(0)
})
