import { expect, test } from "@playwright/test"

test("Given a renewal link without an existing authorized board, when opened, then no automation access can be signed", async ({ page }) => {
  await page.goto("/automation/renew?workspace=missing&definition=missing&executor=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
  const dialog = page.getByRole("dialog", { name: "Restore automation access", exact: true })
  await expect(dialog.getByRole("alert")).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Restore access", exact: true })).toHaveCount(0)
})
