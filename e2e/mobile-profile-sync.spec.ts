import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given an enrolled mobile owner device with large history, when desktop photo changes while mobile is closed, then cold reopening receives the photo without another upload", async ({ page, playwright }, info) => {
  test.setTimeout(120_000)
  const mobileOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
  // WebKitGTK cannot establish this WebRTC path. Linux CI checks delivery in
  // mobile Chromium; separate WebKit tests cover crop and tab presentation.
  // macOS retains the real cross-engine WebKit enrollment and cold-start check.
  const appleWebkit = process.platform === "darwin"
  const mobileBrowser = await (appleWebkit ? playwright.webkit : playwright.chromium).launch()
  const context = await mobileBrowser.newContext(mobileOptions)
  const phone = await context.newPage()
  info.annotations.push({ type: "mobile-browser", description: appleWebkit ? "WebKit" : "Chromium" })
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await page.evaluate(async () => {
      const app = (await import("/src/state.ts")).useTincanban()
      const column = Object.values(app.getActiveDoc()!.entities).find(entity => entity.kind === "column" && entity.title === "Lead")!
      await app.executeCommandAsync({ kind: "createItem", parentId: column.id, title: "Mobile profile history", body: "Description line.\n".repeat(18400) })
    })
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const host = page.getByRole("dialog", { name: "Device sync" })
    await host.getByRole("button", { name: "Add someone", exact: true }).click()
    await host.getByRole("button", { name: "Add my device", exact: true }).click()
    await phone.goto(await host.getByLabel("Pairing link").inputValue())
    const join = phone.getByRole("dialog", { name: "Device sync" })
    const replace = join.getByRole("checkbox", { name: /Replace this device.s identity/ })
    await join.getByRole("button", { name: "Add this device", exact: true }).waitFor({ state: "visible" })
    if (await replace.count()) await replace.check()
    await join.getByRole("button", { name: "Add this device", exact: true }).click()
    await host.getByRole("button", { name: "Approve device", exact: true }).click()
    await expect(join.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30_000 })
    await join.getByRole("button", { name: "Close", exact: true }).click()
    await host.getByRole("button", { name: "Close", exact: true }).click()
    await phone.goto("about:blank")
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    const data = await page.evaluate(() => {
      const canvas = document.createElement("canvas")
      canvas.width = 128; canvas.height = 128
      const paint = canvas.getContext("2d")!
      paint.fillStyle = "#2563eb"; paint.fillRect(0, 0, 128, 128)
      return canvas.toDataURL("image/png").split(",")[1]!
    })
    await page.getByLabel("Choose photo").setInputFiles({ name: "portrait.png", mimeType: "image/png", buffer: Buffer.from(data, "base64") })
    await page.getByRole("dialog", { name: "Crop profile photo" }).getByRole("button", { name: "Save photo", exact: true }).click()
    const photo = page.getByRole("img", { name: "Your profile photo" })
    await expect(photo).toBeVisible()
    const source = await photo.getAttribute("src")
    await phone.goto(new URL("/", page.url()).href)
    await expect(phone.getByLabel("Workspace role: owner")).toBeVisible()
    await phone.getByRole("button", { name: "Menu", exact: true }).click()
    await phone.getByRole("button", { name: "Sync, import & export", exact: true }).click()
    const tabs = phone.getByRole("tab")
    await expect(tabs).toHaveCount(4)
    for (const tab of await tabs.all()) await expect(tab).toHaveCSS("border-bottom-width", "2px")
    await expect(phone.locator(".mesh-member .participant-avatar-photo")).toHaveAttribute("src", source!, { timeout: 30_000 })
    await phone.screenshot({ path: info.outputPath("mobile-profile-arrived.png") })
  } finally { await context.close(); await mobileBrowser.close() }
})
