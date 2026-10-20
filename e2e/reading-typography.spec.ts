import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given local font requests fail, when board and details render, then fallback keeps UI visible and edits persist", async ({ page }) => {
  await page.route("**/assets/*.woff2", route => route.abort())
  await page.goto("/")
  await createJobSearchWorkspace(page, "Fallback test")
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  const create = page.getByRole("dialog", { name: /Add item|Item details/ })
  await create.getByLabel("Company *").fill("Fallback Systems")
  await create.getByLabel("Role *").fill("Reading Engineer")
  await create.getByPlaceholder("Description or notes...").fill("Сохранённый текст при недоступном локальном шрифте")
  await create.getByRole("button", { name: "Create item" }).click()
  const detail = page.getByRole("dialog", { name: "Item overview" })
  await expect(detail.locator(".detail-copy")).toContainText("Сохранённый текст")
  await expect(detail.getByRole("button", { name: "Close detail" })).toBeVisible()
  await detail.getByRole("button", { name: "Close detail" }).click()
  await page.reload()
  await page.getByRole("button", { name: "Open Fallback Systems — Reading Engineer", exact: true }).click()
  await expect(detail.locator(".detail-copy")).toContainText("Сохранённый текст")
})
