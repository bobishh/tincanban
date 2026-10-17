import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

const intakeHash = "561c9b1cbaa3e9518d18b6e0555c1f8d4d11d3a9f4198978842489ec0da45958"

for (const width of [390, 1440]) {
  test(`Given a lead at ${width}px, when inspecting history and copying hashes, then details stay separate and full values remain usable after clipboard failure`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto("/")
    await createJobSearchWorkspace(page, "History windows")
    await page.getByRole("button", { name: "Add lead to Lead", exact: true }).click()
    const form = page.getByRole("dialog", { name: "Add item", exact: true })
    await form.getByLabel("Company *").fill("History Corp")
    await form.getByLabel("Role *").fill("Engineer")
    await form.getByLabel("Description", { exact: true }).fill(`Intake: ${intakeHash}`)
    await form.getByRole("button", { name: "Create item", exact: true }).click()
    const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
    await expect(detail.locator(".item-history-entry")).toHaveCount(0)

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async (value: string) => { sessionStorage.setItem("copied-code", value) },
      } })
    })
    const intake = detail.getByRole("group", { name: "Hash", exact: true })
    await expect(intake.locator("code")).toHaveText(intakeHash)
    await intake.getByRole("button", { name: "Copy Hash", exact: true }).click()
    expect(await page.evaluate(() => sessionStorage.getItem("copied-code"))).toBe(intakeHash)

    const trigger = detail.getByRole("button", { name: "History", exact: true })
    await trigger.click()
    const history = page.getByRole("dialog", { name: "Item history", exact: true })
    const entry = history.locator(".item-history-entry").first()
    await entry.getByText("Technical details", { exact: true }).click()
    const hash = entry.getByRole("group", { name: "Change hash", exact: true })
    const fullHash = await hash.locator("code").innerText()
    expect(fullHash).toMatch(/^[a-f0-9]{64}$/)
    await hash.getByRole("button", { name: "Copy Change hash", exact: true }).click()
    expect(await page.evaluate(() => sessionStorage.getItem("copied-code"))).toBe(fullHash)
    await expect(hash.getByRole("status")).toHaveText("Copied")

    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async () => { throw new Error("Clipboard denied") },
    } }) })
    await hash.getByRole("button", { name: "Copy Change hash", exact: true }).click()
    await expect(hash.getByRole("status")).toContainText("Select the code")
    await expect(hash.locator("code")).toHaveText(fullHash)
    expect(await hash.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    expect(await history.locator(".scroll-frame").evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)

    await history.getByRole("button", { name: "Load earlier history", exact: true }).scrollIntoViewIfNeeded()
    const load = await history.getByRole("button", { name: "Load earlier history", exact: true }).boundingBox()
    const last = await history.locator(".item-history-entry").last().boundingBox()
    expect(load!.y).toBeGreaterThanOrEqual(last!.y + last!.height)
    await history.locator(".scroll-frame-viewport").evaluate(element => { element.scrollTop = 0 })
    await page.screenshot({ path: testInfo.outputPath("history.png"), animations: "disabled" })
    await history.getByRole("button", { name: "Close history", exact: true }).click()
    await expect(history).toBeHidden()
    await expect(detail).toBeVisible()
    await expect(trigger).toBeFocused()
    await page.screenshot({ path: testInfo.outputPath("detail.png"), animations: "disabled" })
  })
}
