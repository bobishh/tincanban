import { expect, test, type Page } from "./support/coverage"

const transportAsset = /\/meta_mesh_bg(?:-[\w-]+)?\.wasm(?:\?|$)/

async function createBoard(page: Page) {
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Policy only")

  await create.getByRole("button", { name: "Create", exact: true }).click()
  await expect(create).toBeHidden()
}

async function createItem(page: Page, title: string) {
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill(title)
  await form.getByRole("button", { name: "Save item", exact: true }).click()
  await expect(form).toBeHidden()
  await expect(page.getByRole("button", { name: `Open ${title}`, exact: true })).toBeVisible()
}

test("Given persisted authorized local data, when transport assets are unavailable, then the board opens and local edits survive reload without transport requests", async ({ page }) => {
  const transportRequests: string[] = []
  page.on("request", request => { if (transportAsset.test(request.url())) transportRequests.push(request.url()) })
  await page.route(transportAsset, route => route.abort("failed"))
  await page.goto("/")
  await createBoard(page)
  if (process.env.TINCANBAN_EXPECT_BUILD) {
    await expect(page.getByRole("contentinfo", { name: "tincanban build information" }))
      .toContainText(process.env.TINCANBAN_EXPECT_BUILD.slice(0, 7))
  }
  await createItem(page, "Before reload")
  await page.reload()
  await expect(page.getByRole("button", { name: "Open Before reload", exact: true })).toBeVisible()
  await createItem(page, "After reload")
  await page.reload()
  await expect(page.getByRole("button", { name: "Open After reload", exact: true })).toBeVisible()
  expect(transportRequests).toEqual([])
})

test("Given unavailable transport, when invitation creation fails, then local edits remain usable and retry can create an invitation", async ({ page }) => {
  test.setTimeout(60_000)
  await page.route(transportAsset, route => route.abort("failed"))
  await page.goto("/")
  await createBoard(page)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const sync = page.getByRole("dialog", { name: "Device sync" })
  await sync.getByRole("button", { name: "Add someone" }).click()
  await sync.getByRole("button", { name: "Generate link" }).click()
  await expect(sync.getByRole("alert")).toBeVisible()
  await sync.getByRole("button", { name: "Dismiss", exact: true }).click()
  await createItem(page, "Transport failed, saved locally")
  await page.unroute(transportAsset)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  await sync.getByRole("button", { name: "Add someone" }).click()
  await sync.getByRole("button", { name: "Generate link" }).click()
  await expect(sync.getByLabel("Pairing link")).toHaveValue(/\/pair#/, { timeout: 30_000 })
})

test("Given unavailable policy WASM, when startup runs, then local access stays blocked with an explicit runtime error", async ({ page }) => {
  await page.route(/\/meta_mesh_policy_bg(?:-[\w-]+)?\.wasm(?:\?|$)/, route => route.abort("failed"))
  await page.goto("/")
  await expect(page.getByRole("alert")).toContainText("Could not load tincanban’s local runtime.")
  await expect(page.getByRole("button", { name: /Add item to/ })).toHaveCount(0)
})
