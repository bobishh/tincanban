import { expect, type Page } from "@playwright/test"

export async function createJobSearchWorkspace(page: Page, title = "Job search"): Promise<void> {
  const openWorkspaces = page.getByRole("button", { name: "Open workspaces" })
  await expect(openWorkspaces).toBeEnabled({ timeout: 25_000 })
  await openWorkspaces.click()
  await page.getByRole("button", { name: "New workspace" }).click()

  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title", { exact: true }).fill(title)
  await dialog.getByRole("radio", { name: "Job search" }).check()
  await dialog.getByRole("button", { name: "Create", exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole("region", { name: title.trim(), exact: true })).toBeVisible()
}

export async function ensureJobSearchWorkspace(page: Page): Promise<void> {
  if (await page.getByRole("button", { name: /Add lead to/ }).count()) return

  const openWorkspaces = page.getByRole("button", { name: "Open workspaces" })
  await expect(openWorkspaces).toBeEnabled({ timeout: 25_000 })
  await openWorkspaces.click()
  const workspaces = page.getByRole("dialog", { name: "Workspaces" })
  const existing = workspaces.getByRole("button", { name: /^jobs(?: Active)?$/ })
  if (await existing.count()) {
    await existing.click()
    await page.getByRole("button", { name: /Add lead to/ }).first().waitFor()
    return
  }

  await workspaces.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Job search")
  await create.getByRole("radio", { name: "Job search" }).check()
  await create.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByRole("button", { name: /Add lead to/ }).first().waitFor()
}
