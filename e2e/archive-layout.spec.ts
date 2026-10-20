import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given collapsible Rejected and Archive columns, when each is toggled, then their local states stay independent", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const rejected = page.getByRole("region", { name: "Rejected", exact: true })
  const archive = page.getByRole("region", { name: "Archive", exact: true })
  await rejected.getByRole("button", { name: "Collapse Rejected" }).click()
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
  await expect(archive.getByRole("button", { name: "Open Archive with 0 cards" })).toBeVisible()
  await archive.getByRole("button", { name: "Open Archive with 0 cards" }).click()
  await expect(archive.getByText("No leads")).toBeVisible()
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("region", { name: "Rejected", exact: true }).getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
})

test("Given archive role moves, when the board updates, then old preset bindings do not keep old column styled as Archive", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const oldArchive = page.getByRole("region", { name: "Archive", exact: true })
  const nextArchive = page.getByRole("region", { name: "Rejected", exact: true })
  await expect(oldArchive).toHaveClass(/column-archived/)

  await page.evaluate(async () => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const { projectWorkspaceSettings } = await import("/src/domain/workspaceSettings.ts")
    const tincanban = useTincanban()
    const doc = tincanban.getActiveDoc()
    if (!doc) throw new Error("Workspace document unavailable")
    const settings = projectWorkspaceSettings(doc)
    const old = settings.board.columns.find(column => column.archive)
    const next = settings.board.columns.find(column => column.title === "Rejected")
    if (!old || !next) throw new Error("Expected old and new Archive columns")
    delete old.archive
    next.archive = true
    await tincanban.executeCommandAsync({ kind: "updateWorkspaceSettings", settings })
  })

  await expect(oldArchive).not.toHaveClass(/column-archived|bin-column/)
  await expect(nextArchive).toHaveClass(/bin-column/)
  await nextArchive.getByRole("button", { name: "Open Rejected with 0 cards" }).click()
  await expect(nextArchive).toHaveClass(/bin-column-open/)
})

test("Given invalid local collapse preferences, when the board loads, then preferences recover and collapse controls remain usable", async ({ page }) => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem
    Storage.prototype.getItem = function (key: string) {
      return key.startsWith("tincanban:collapsed-columns:") ? "{" : getItem.call(this, key)
    }
  })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  const rejected = page.getByRole("region", { name: "Rejected", exact: true })
  await expect(rejected.getByRole("button", { name: "Collapse Rejected" })).toBeVisible()
  await rejected.getByRole("button", { name: "Collapse Rejected" }).click()
  await expect(rejected.getByRole("button", { name: "Open Rejected with 0 cards" })).toBeVisible()
})
