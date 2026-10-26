import { expect, test } from "./support/coverage"

const identityOrigin = process.env.IDENTITY_E2E_ORIGIN
test.skip(!identityOrigin, "Set IDENTITY_E2E_ORIGIN to an isolated Identity server")

test("Given an Identity with a photo, when signing in from the narrow menu and reloading, then keep the profile only in Settings", async ({ page, context }) => {
  test.setTimeout(120_000)
  const portal = await context.newPage()
  await portal.goto(identityOrigin!)
  await portal.getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.locator('#create-form input[name="displayName"]').fill("Photo Owner")
  await portal.locator("#create-form").getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.getByRole("heading", { name: "Save your recovery" }).waitFor()
  const download = portal.waitForEvent("download")
  await portal.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
  await download
  await portal.locator('input[name="saved-words"]').check()
  await portal.getByRole("button", { name: "Continue to identity", exact: true }).click()
  await portal.getByRole("heading", { name: "Photo Owner", exact: true }).waitFor()
  await portal.getByRole("button", { name: "Edit profile", exact: true }).click()
  const image = await portal.evaluate(() => {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 128
    const drawing = canvas.getContext("2d")!
    drawing.fillStyle = "#d34630"
    drawing.fillRect(0, 0, 128, 128)
    return canvas.toDataURL("image/png").split(",")[1]!
  })
  await portal.getByLabel("Change avatar", { exact: true }).setInputFiles({
    name: "portrait.png", mimeType: "image/png", buffer: Buffer.from(image, "base64"),
  })
  await portal.getByRole("button", { name: "Save changes", exact: true }).click()
  const personId = await portal.locator(".identity-id-badge").getAttribute("data-identity-id")
  await page.setViewportSize({ width: 729, height: 1000 })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled()
  await expect(page.getByRole("button", { name: "Identity", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Menu", exact: true }).click()
  await page.getByRole("dialog", { name: "Navigation menu" }).getByRole("button", { name: "Sign in", exact: true }).click()
  await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
  await page.getByLabel("Allow this app to use the Identity shown above.").check()
  await page.getByRole("button", { name: "Approve app device", exact: true }).click()
  const approval = page.getByRole("dialog", { name: "Identity profile", exact: true })
  await approval.getByLabel("I understand this changes the active Identity and may leave local boards inaccessible.").check()
  await approval.getByRole("button", { name: "Continue with this Identity", exact: true }).click()
  await expect(page.getByRole("button", { name: /Open profile for/ })).toHaveCount(0)
  const openSettings = async () => {
    await page.getByRole("button", { name: "Menu", exact: true }).click()
    const menu = page.getByRole("dialog", { name: "Navigation menu" })
    await expect(menu.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0)
    await menu.getByRole("button", { name: "Settings", exact: true }).click()
  }
  await openSettings()
  const profile = page.getByRole("region", { name: "Your profile", exact: true })
  await expect(profile).toBeVisible()
  await expect(profile).toContainText("Photo Owner")
  await expect(profile.locator("img")).toBeVisible()
  await expect(profile).toHaveAttribute("data-person-id", personId!)
  await page.reload()
  await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled()
  await openSettings()
  await expect(profile).toBeVisible()
  expect(await profile.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Open profile for/ })).toHaveCount(0)
  await expect(profile.getByRole("link", { name: "Edit profile", exact: true })).toHaveAttribute("href", `${identityOrigin}/profile`)
  await expect(page.getByRole("dialog", { name: "Identity profile", exact: true })).toHaveCount(0)
  await portal.close()
})

test("Given a substituted Identity approval, when returning to the app, then reject it and start a fresh request on the next Sign in", async ({ page, context }) => {
  test.setTimeout(120_000)
  const portal = await context.newPage()
  await portal.goto(identityOrigin!)
  await portal.getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.locator('#create-form input[name="displayName"]').fill("Approval Owner")
  await portal.locator("#create-form").getByRole("button", { name: "Create identity", exact: true }).click()
  await portal.getByRole("heading", { name: "Save your recovery" }).waitFor()
  const download = portal.waitForEvent("download")
  await portal.getByRole("button", { name: "Download encrypted identity file", exact: true }).click()
  await download
  await portal.locator('input[name="saved-words"]').check()
  await portal.getByRole("button", { name: "Continue to identity", exact: true }).click()
  await page.addInitScript(() => {
    if (location.pathname !== "/identity/return") return
    const params = new URLSearchParams(location.hash.slice(1))
    const encoded = params.get("approval")
    if (!encoded) return
    const approval = JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")))
    approval.identity.displayName = "Substituted profile"
    params.set("approval", btoa(JSON.stringify(approval)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""))
    history.replaceState(null, "", `${location.pathname}#${params}`)
  })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled()
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
  const firstRequest = new URL(page.url()).hash
  await page.getByLabel("Allow this app to use the Identity shown above.").check()
  await page.getByRole("button", { name: "Approve app device", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Identity profile", exact: true })
  await expect(dialog.getByRole("alert")).toContainText("signed profile")
  await expect(page.getByRole("button", { name: /Open profile for/ })).toHaveCount(0)
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.getByRole("heading", { name: "Authorize app device" }).waitFor()
  expect(new URL(page.url()).hash).not.toBe(firstRequest)
  await portal.close()
})
