import { expect, test, type Page } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

async function openRejectedCard(page: Page) {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Rejection drafts")
  await page.getByRole("region", { name: "Lead", exact: true }).getByRole("button", { name: "Add lead to Lead", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Add item", exact: true })
  await form.getByLabel("Company *", { exact: true }).fill("Draft Corp")
  await form.getByLabel("Role *", { exact: true }).fill("Engineer")
  await form.getByRole("button", { name: "Create item", exact: true }).click()
  const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
  await detail.getByRole("button", { name: "Rejected", exact: true }).click()
  await expect(detail.getByRole("textbox", { name: "Rejection notes", exact: true })).toBeVisible()
  return detail
}

test("Given a rejected card, when typing continuously, then input stays local until idle and survives reload", async ({ page }) => {
  const detail = await openRejectedCard(page)
  await page.evaluate(async () => {
    const { defaultStorage } = await import("/src/storage.ts")
    const original = defaultStorage.commitDelta.bind(defaultStorage)
    ;(window as any).__noteCommits = 0
    defaultStorage.commitDelta = async (...args: Parameters<typeof original>) => {
      ;(window as any).__noteCommits++
      return original(...args)
    }
  })
  const input = detail.getByRole("textbox", { name: "Rejection notes", exact: true })
  await input.pressSequentially("Timing did not work", { delay: 20 })
  await expect(input).toHaveValue("Timing did not work")
  expect(await page.evaluate(() => (window as any).__noteCommits)).toBe(0)
  await expect(detail.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__noteCommits)).toBe(1)
  await page.reload()
  await page.getByRole("button", { name: "Open Draft Corp — Engineer", exact: true }).click()
  await expect(input).toHaveValue("Timing did not work")
  await input.fill("")
  await detail.getByRole("button", { name: "Close detail", exact: true }).click()
  await expect(detail).not.toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "Open Draft Corp — Engineer", exact: true }).click()
  await expect(input).toHaveValue("")
})

test("Given storage fails, when closing a dirty card, then draft stays visible and retry saves it", async ({ page }) => {
  const detail = await openRejectedCard(page)
  const input = detail.getByRole("textbox", { name: "Rejection notes", exact: true })
  await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
  await input.fill("Keep my explanation")
  await detail.getByRole("button", { name: "Close detail", exact: true }).click()
  await expect(detail.getByRole("alert")).toContainText("Not saved")
  await expect(input).toHaveValue("Keep my explanation")
  await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })
  await detail.getByRole("button", { name: "Retry save", exact: true }).click()
  await expect(detail.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: "Open Draft Corp — Engineer", exact: true }).click()
  await expect(input).toHaveValue("Keep my explanation")
})

test("Given a slow save, when typing newer text, then saved updates never overwrite the draft", async ({ page }) => {
  const detail = await openRejectedCard(page)
  await page.evaluate(async () => {
    const { defaultStorage } = await import("/src/storage.ts")
    const original = defaultStorage.commitDelta.bind(defaultStorage)
    let first = true
    defaultStorage.commitDelta = async (...args: Parameters<typeof original>) => {
      if (first) {
        first = false
        await new Promise<void>(resolve => { (window as any).__releaseNoteSave = resolve })
      }
      return original(...args)
    }
  })
  const input = detail.getByRole("textbox", { name: "Rejection notes", exact: true })
  await input.fill("First")
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseNoteSave)).toBe("function")
  await input.press("End")
  await input.pressSequentially(" plus latest")
  await expect(input).toHaveValue("First plus latest")
  await page.evaluate(() => (window as any).__releaseNoteSave())
  await expect(detail.getByRole("status").filter({ hasText: /^Saved$/ })).toBeVisible()
  await expect(input).toHaveValue("First plus latest")
  await page.reload()
  await page.getByRole("button", { name: "Open Draft Corp — Engineer", exact: true }).click()
  await expect(input).toHaveValue("First plus latest")
})
