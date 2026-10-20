import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given a new lead, when its detail module is still loading then a pending status precedes the window", async ({ page }) => {
  let releaseModule!: () => void
  const moduleGate = new Promise<void>(resolve => { releaseModule = resolve })
  await page.route(/ItemDetailDialog\.vue/, async route => {
    await moduleGate
    await route.continue()
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/")
  await createJobSearchWorkspace(page, "Async detail")
  await page.getByRole("region", { name: "Lead" }).getByRole("button", { name: "Add lead to Lead" }).click()
  const form = page.getByRole("dialog", { name: "Add item" })
  await form.getByLabel("Company *").fill("Async Corp")
  await form.getByLabel("Role *").fill("Engineer")

  await form.getByRole("button", { name: "Create item" }).click()
  await expect(page.getByRole("status").filter({ hasText: "Opening item…" })).toBeVisible()
  releaseModule()
  const details = page.getByRole("dialog", { name: "Item overview" })
  await expect(details).toBeVisible()
  await expect(details).toBeFocused()
})
