import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given two private boards, when switching, reloading and using history, then each stable address reopens that same board", async ({ page }) => {
  await page.goto("/")
  await createJobSearchWorkspace(page, "First private board")
  await expect(page).toHaveURL(/\/boards\/[^/]+\/first-private-board$/)
  const first = page.url()
  await createJobSearchWorkspace(page, "Вторая доска")
  const second = page.url()
  expect(second).not.toBe(first)
  await page.reload()
  await expect(page.getByRole("region", { name: "Вторая доска", exact: true })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("region", { name: "First private board", exact: true })).toBeVisible()
  await expect(page).toHaveURL(first)
  await page.goForward()
  await expect(page.getByRole("region", { name: "Вторая доска", exact: true })).toBeVisible()
  await page.goto(new URL(first).pathname.replace(/\/first-private-board$/, "/old-title") + "?view=board#target")
  await expect(page.getByRole("region", { name: "First private board", exact: true })).toBeVisible()
  await expect(page).toHaveURL(first + "?view=board#target")
})

test("Given local boards, when a private address is unavailable, then show a usable error without exposing a different board or trapping the startup cover", async ({ page }) => {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Known private board")
  await page.route("**/v1/public/boards/missing-board", route => route.fulfill({ status: 404, json: { message: "Unavailable" } }))
  await page.goto("/boards/missing-board/missing")
  await expect(page.getByRole("heading", { name: "Board unavailable", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled()
  await expect(page.getByRole("region", { name: "Known private board", exact: true })).toHaveCount(0)
  await page.getByRole("link", { name: "Open local boards", exact: true }).click()
  await expect(page.getByRole("region", { name: "Known private board", exact: true })).toBeVisible()
})
