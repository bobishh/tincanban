import { expect, type Page } from "@playwright/test"

/** Historical configured-board fixture; production offers no jobs preset. */
export async function createJobSearchWorkspace(page: Page, title = "Job search"): Promise<void> {
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 25_000 })
  await page.evaluate(async title => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    await useTincanban().createWorkspaceAsync(title, "job-search")
  }, title)
  await expect(page.getByRole("region", { name: title.trim(), exact: true })).toBeVisible()
}
export async function ensureJobSearchWorkspace(page: Page): Promise<void> {
  if (await page.getByRole("button", { name: /Add lead to/ }).count()) return
  await createJobSearchWorkspace(page)
}

export async function addJobSearchLead(page: Page, company: string): Promise<void> {
  await page.getByRole("region", { name: "Lead", exact: true })
    .getByRole("button", { name: "Add lead to Lead", exact: true }).click()
  const create = page.getByRole("dialog", { name: "Add item" })
  await create.getByLabel("Company *").fill(company)
  await create.getByLabel("Role *").fill("Engineer")
  await create.getByRole("button", { name: "Create item", exact: true }).click()
  await page.getByRole("button", { name: "Close detail", exact: true }).click()
}
