import { expect, test } from "./support/coverage"

test("Given the Rust policy runtime request fails, when tincanban opens, then it identifies the runtime rather than local data", async ({ page }) => {
  await page.route(/\/meta_mesh_policy_bg(?:-[\w-]+)?\.wasm(?:\?.*)?$/, route => route.abort("failed"))

  await page.goto("/")

  const alert = page.getByRole("alert")
  await expect(alert).toContainText("Could not load tincanban’s local runtime")
  await expect(alert).not.toContainText("Could not open your local data")
  await expect(alert).toBeInViewport()
  await expect(page.locator(".boot-placeholder")).toHaveCount(0)
  await expect(page.locator(".topbar")).toBeVisible()
})
