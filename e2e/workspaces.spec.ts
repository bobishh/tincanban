import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace, ensureJobSearchWorkspace } from "./support/workspaces"

test("Given boards with identical names, when choosing an invitation scope, then the current board is distinct and an empty selection cannot generate a link", async ({ page }) => {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Job search")
  await createJobSearchWorkspace(page, "Job search")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await dialog.getByRole("button", { name: "Add someone" }).click()
  const current = dialog.getByRole("checkbox", { name: /Job search.*Current board/ })
  await expect(current).toBeChecked()
  const names = await dialog.getByRole("checkbox", { name: /Job search/ }).evaluateAll(inputs => inputs.map(input => input.getAttribute("aria-label")))
  expect(names).toHaveLength(2)
  expect(new Set(names).size).toBe(2)
  await current.uncheck()
  await expect(dialog.getByRole("button", { name: "Generate link" })).toBeDisabled()
  await dialog.getByRole("checkbox", { name: names.find(name => !name?.includes("Current board"))!, exact: true }).check()
  await expect(current).not.toBeChecked()
  await expect(dialog.getByRole("button", { name: "Generate link" })).toBeEnabled()
})

test.describe("Workspaces and Generic Board UI (Outer Scenarios)", () => {
  test("Given an owner workspace, when access is checked after reload, then visitor role never flashes", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByRole("img", { name: "Workspace role: owner" })).toBeVisible()
    await page.addInitScript(() => {
      (window as Window & { __visitorFlashed?: boolean }).__visitorFlashed = false
      new MutationObserver(() => {
        if (document.querySelector('[aria-label="Workspace role: visitor"]')) {
          (window as Window & { __visitorFlashed?: boolean }).__visitorFlashed = true
        }
      }).observe(document, { childList: true, subtree: true, attributes: true })
    })
    await page.reload()
    await expect(page.getByRole("img", { name: "Workspace role: owner" })).toBeVisible()
    expect(await page.evaluate(() => (window as Window & { __visitorFlashed?: boolean }).__visitorFlashed)).toBe(false)
  })

  test("Given a new profile, when tincanban opens, then it starts with a collision-safe blank Untitled workspace", async ({ page }) => {
    await page.goto("/")

    await expect(page.getByRole("heading", { name: "TINCANBAN // Untitled" })).toBeVisible()
    await expect(page.getByRole("region", { name: "To do" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Lead" })).toHaveCount(0)
    await expect.poll(() => page.evaluate(async () => (await import("/src/localDb.ts")).readLocal("tincanban.active_workspace_id"))).not.toBe("default")
  })

  test("Given two first tabs, when both open together, then they share one generated Untitled workspace", async ({ page }) => {
    const peer = await page.context().newPage()
    try {
      await Promise.all([page.goto("/"), peer.goto("/")])
      await Promise.all([
        expect(page.getByRole("heading", { name: "TINCANBAN // Untitled" })).toBeVisible(),
        expect(peer.getByRole("heading", { name: "TINCANBAN // Untitled" })).toBeVisible(),
      ])
      const activeId = (target: typeof page) => target.evaluate(async () => (await import("/src/localDb.ts")).readLocal("tincanban.active_workspace_id"))
      await expect.poll(() => activeId(peer)).toBe(await activeId(page))
      await page.getByRole("button", { name: "Open workspaces" }).click()
      await expect(page.getByRole("dialog", { name: "Workspaces" }).locator(".workspace-item")).toHaveCount(1)
    } finally {
      await peer.close()
    }
  })

  test("Given two workspaces, when either is renamed from the workspace list, then its data and new name persist", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const create = page.getByRole("dialog", { name: "Create workspace" })
    await create.getByLabel("Title").fill("Project board")

    await create.getByRole("button", { name: "Create" }).click()
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const item = page.getByRole("dialog", { name: "Item details" })
    await item.getByLabel("Title *").fill("Kept card")
    await item.getByRole("button", { name: "Save item" }).click()

    await page.getByRole("button", { name: "Open workspaces" }).click()
    const workspaces = page.getByRole("dialog", { name: "Workspaces" })
    await workspaces.locator(".workspace-item", { hasText: "Project board" }).getByRole("button", { name: "Rename", exact: true }).click()
    await workspaces.getByRole("textbox", { name: "Workspace name" }).fill("Client board")
    await workspaces.getByRole("button", { name: "Save name" }).click()
    await expect(workspaces.locator(".workspace-switch", { hasText: "Client board" })).toBeVisible()
    await workspaces.locator(".workspace-switch").filter({ hasText: "Untitled" }).click()
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await workspaces.locator(".workspace-item", { hasText: "Client board" }).getByRole("button", { name: "Rename", exact: true }).click()
    await workspaces.getByRole("textbox", { name: "Workspace name" }).fill("")
    await workspaces.getByRole("button", { name: "Save name" }).click()
    await expect(workspaces.getByRole("alert")).toHaveText("Workspace name is required")
    await workspaces.getByRole("textbox", { name: "Workspace name" }).fill("Client board renamed")
    await workspaces.getByRole("button", { name: "Save name" }).click()
    await workspaces.locator(".workspace-switch").filter({ hasText: "Client board renamed" }).click()
    await expect(page.getByRole("button", { name: "Open Kept card" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("heading", { name: "TINCANBAN // Client board renamed" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open Kept card" })).toBeVisible()
  })

  test("Given workspace rename persistence fails, when save is attempted, then the form keeps the draft and shows the error", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    const workspaces = page.getByRole("dialog", { name: "Workspaces" })
    await workspaces.locator(".workspace-item", { hasText: "Untitled" }).getByRole("button", { name: "Rename", exact: true }).click()
    await workspaces.getByRole("textbox", { name: "Workspace name" }).fill("Still editable")
    await page.evaluate(() => { (window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
    await workspaces.getByRole("button", { name: "Save name" }).click()
    await expect(workspaces.getByRole("alert")).toContainText("Storage failure injected")
    await expect(workspaces.getByRole("textbox", { name: "Workspace name" })).toHaveValue("Still editable")
    await expect(workspaces.getByRole("button", { name: "Save name" })).toBeEnabled()
    await page.evaluate(() => { delete (window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ })
  })

  test("Given workspace archive save is pending and fails, when Archive is retried, then controls recover and fallback persists", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    const dialog = page.getByRole("dialog", { name: "Workspaces" })
    await dialog.getByRole("button", { name: "New workspace" }).click()
    const create = page.getByRole("dialog", { name: "Create workspace" })
    await create.getByLabel("Title").fill("Archive pending board")

    await create.getByRole("button", { name: "Create" }).click()
    await page.getByRole("button", { name: "Open workspaces" }).click()
    const workspace = dialog.locator(".workspace-item", { hasText: "Archive pending board" })
    await workspace.getByRole("button", { name: "Archive", exact: true }).click()
    await page.evaluate(async () => {
      type ArchiveGateWindow = Window & { __TINCANBAN_ARCHIVE_GATE__?: { started: boolean; reject: () => void; restore: () => void } }
      const storage = (await import("/src/storage.ts")).defaultStorage
      const prototype = Object.getPrototypeOf(storage) as { commitWorkspace: typeof storage.commitWorkspace }
      const original = prototype.commitWorkspace
      let pending = true
      let rejectCommit: ((reason: Error) => void) | undefined
      const gateWindow = window as ArchiveGateWindow
      gateWindow.__TINCANBAN_ARCHIVE_GATE__ = {
        started: false,
        reject: () => {
          pending = false
          rejectCommit?.(new Error("Storage failure injected"))
        },
        restore: () => { prototype.commitWorkspace = original },
      }
      prototype.commitWorkspace = function (this: typeof storage, ...args: Parameters<typeof original>) {
        if (!pending) return original.apply(this, args)
        return new Promise((resolve, reject) => {
          rejectCommit = reject
          gateWindow.__TINCANBAN_ARCHIVE_GATE__!.started = true
        }) as ReturnType<typeof original>
      }
    })
    await workspace.getByRole("button", { name: "Archive workspace" }).click()
    await expect.poll(() => page.evaluate(() => (window as Window & { __TINCANBAN_ARCHIVE_GATE__?: { started: boolean } }).__TINCANBAN_ARCHIVE_GATE__?.started)).toBe(true)
    await expect.poll(() => dialog.getByRole("button", { name: "Archive", exact: true }).evaluateAll(buttons => buttons.every(button => (button as HTMLButtonElement).disabled))).toBe(true)
    await expect(workspace.getByRole("button", { name: "Cancel" })).toBeDisabled()
    await expect(workspace.getByRole("button", { name: "Archiving…" })).toBeDisabled()
    await page.evaluate(() => (window as Window & { __TINCANBAN_ARCHIVE_GATE__?: { reject: () => void } }).__TINCANBAN_ARCHIVE_GATE__?.reject())
    await expect(workspace.getByRole("alert")).toContainText("Storage failure injected")
    await expect(workspace.getByRole("button", { name: "Archive workspace" })).toBeEnabled()
    await expect(workspace.getByRole("button", { name: "Archive", exact: true })).toBeEnabled()
    await expect(workspace.getByRole("button", { name: "Cancel" })).toBeEnabled()
    await expect(workspace.locator(".workspace-switch").filter({ hasText: "Archive pending board" })).toBeVisible()
    await page.evaluate(() => (window as Window & { __TINCANBAN_ARCHIVE_GATE__?: { restore: () => void } }).__TINCANBAN_ARCHIVE_GATE__?.restore())
    await workspace.getByRole("button", { name: "Archive workspace" }).click()
    await expect(dialog.locator(".workspace-switch").filter({ hasText: "Archive pending board" })).toHaveCount(0)
    await expect(dialog.locator(".workspace-switch").filter({ hasText: "Untitled" })).toBeVisible()
    await dialog.getByRole("button", { name: "Close" }).last().click()
    await expect(page.getByRole("heading", { name: "TINCANBAN // Untitled" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("heading", { name: "TINCANBAN // Untitled" })).toBeVisible()
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await dialog.getByRole("button", { name: "Show archived" }).click()
    await expect(dialog.locator(".workspace-item", { hasText: "Archive pending board" })).toBeVisible()
  })

  test("Given local workspaces, when archive is cancelled or confirmed, then cards remain recoverable and active workspace changes", async ({ page }, testInfo) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Open workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const create = page.getByRole("dialog", { name: "Create workspace" })
    await create.getByLabel("Title").fill("Temporary board")

    await create.getByRole("button", { name: "Create" }).click()
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const item = page.getByRole("dialog", { name: "Item details" })
    await item.getByLabel("Title *").fill("Temporary data")
    await item.getByRole("button", { name: "Save item" }).click()

    await page.getByRole("button", { name: "Open workspaces" }).click()
    const dialog = page.getByRole("dialog", { name: "Workspaces" })
    const temporary = dialog.locator(".workspace-item", { hasText: "Temporary board" })
    await temporary.getByRole("button", { name: "Archive", exact: true }).click()
    const confirmation = temporary.getByRole("group", { name: "Archive Temporary board" })
    await expect(confirmation).toContainText("cards and documents remain saved")
    await confirmation.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog.locator(".workspace-switch").filter({ hasText: "Temporary board" })).toBeVisible()
    await temporary.getByRole("button", { name: "Archive", exact: true }).click()
    await confirmation.getByRole("button", { name: "Archive workspace" }).click()
    await expect(dialog.locator(".workspace-switch").filter({ hasText: "Temporary board" })).toHaveCount(0)
    await expect(dialog.locator(".workspace-switch").filter({ hasText: "Untitled" })).toBeVisible()
    await dialog.getByRole("button", { name: "Close" }).last().click()
    await expect(page.getByRole("heading", { name: "TINCANBAN // Untitled" })).toBeVisible()
    await page.reload()
    await expect(page.getByRole("heading", { name: "TINCANBAN // Untitled" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open Temporary data" })).toHaveCount(0)
    await page.getByRole("button", { name: "Open workspaces" }).click()
    const restoredDialog = page.getByRole("dialog", { name: "Workspaces" })
    await restoredDialog.getByRole("button", { name: "Show archived" }).click()
    const restore = restoredDialog.getByRole("button", { name: "Restore workspace" })
    await expect(restore).toHaveCSS("text-transform", "uppercase")
    await expect(restore).toHaveCSS("border-radius", "0px")
    await page.evaluate(() => { (window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
    await restore.click()
    await expect(restoredDialog.getByRole("alert")).toBeVisible()
    await expect(restore).toBeEnabled()
    await page.screenshot({ animations: "disabled", path: testInfo.outputPath("workspace-restore-error.png") })
    await page.evaluate(() => { (window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })
    await restore.click()
    await expect(restoredDialog.locator(".workspace-switch").filter({ hasText: "Temporary board" })).toBeVisible()
    await restoredDialog.locator(".workspace-switch").filter({ hasText: "Temporary board" }).click()
    await expect(page.getByRole("button", { name: "Open Temporary data" })).toBeVisible()
  })

  test("Given tincanban is opened, when a Blank board workspace is created, then it seeds To do, Doing, Done columns without job-search fields", async ({ page }) => {
    await page.goto("/")

    // Open workspace switcher or creation dialog
    await page.getByRole("button", { name: "Workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()

    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await expect(dialog).toBeVisible()
    await dialog.getByLabel("Title").fill("Reading List")

    await dialog.getByRole("button", { name: "Create" }).click()

    // Expect generic board with default columns
    await expect(page.getByRole("heading", { name: "Reading List" })).toBeVisible()
    await expect(page.getByRole("region", { name: "To do" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Doing" })).toBeVisible()
    await expect(page.getByRole("region", { name: "Done" })).toBeVisible()

    // No job-search columns or company/role inputs should exist
    await expect(page.getByRole("region", { name: "Lead" })).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Interview" })).toHaveCount(0)

    // Adding a card on blank board opens a generic item form (Title + Body, not Company + Role)
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const itemForm = page.getByRole("dialog", { name: "Item details" })
    await expect(itemForm.getByLabel("Title *")).toBeVisible()
    await expect(itemForm.getByLabel("Company *")).toHaveCount(0)
  })

  test("Given a board with columns, when a column is renamed, then the new title persists after reload", async ({ page }) => {
    await page.goto("/")

    // In a generic board workspace
    await page.getByRole("button", { name: "Workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await dialog.getByLabel("Title").fill("Project Board")

    await dialog.getByRole("button", { name: "Create" }).click()

    // Rename "To do" column to "Backlog"
    const columnHeader = page.getByRole("region", { name: "To do" })
    await page.getByRole("button", { name: "Edit board" }).click()
    await columnHeader.getByRole("button", { name: "Edit column" }).click()
    const colDialog = page.getByRole("dialog", { name: "Edit column" })
    await colDialog.getByLabel("Column title").fill("Backlog")
    await colDialog.getByRole("button", { name: "Save" }).click()

    await expect(page.getByRole("region", { name: "Backlog" })).toBeVisible()
    await expect(page.getByRole("region", { name: "To do" })).toHaveCount(0)

    // Reload page to verify persistence
    await page.reload()
    await expect(page.getByRole("region", { name: "Backlog" })).toBeVisible()
  })

  test("Given a board with a required custom field, when an item is saved without that field, then validation fails without creating the item", async ({ page }) => {
    await page.goto("/")

    await page.getByRole("button", { name: "Workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await dialog.getByLabel("Title").fill("Bug Tracker")

    await dialog.getByRole("button", { name: "Create" }).click()

    // Add a required text field "Severity"
    await page.getByRole("button", { name: "Edit board" }).click()
    await page.getByRole("button", { name: "Edit item" }).click()
    const settings = page.getByRole("dialog", { name: "Edit item" })
    await settings.getByRole("button", { name: "+ Add field" }).click()
    await settings.getByLabel("Field name").fill("Severity")
    await settings.getByLabel("Type").selectOption("text")
    await settings.getByLabel("Required").check()
    await settings.getByRole("button", { name: "Save field" }).click()
    await settings.getByRole("button", { name: "Review changes" }).click()
    await page.getByRole("dialog", { name: "Review schema changes" }).getByRole("button", { name: "Confirm apply" }).click()
    await page.getByRole("button", { name: "Done" }).click()

    // Attempt to create an item leaving required "Severity" empty
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    const itemForm = page.getByRole("dialog", { name: "Item details" })
    await itemForm.getByLabel("Title *").fill("Crash on click")
    await itemForm.getByRole("button", { name: "Save item" }).click()

    // Validation error should show and item dialog remains open
    await expect(itemForm.getByRole("alert")).toHaveText(/Severity is required/)
    await expect(itemForm).toBeVisible()

    // Cancel / close form
    await itemForm.getByRole("button", { name: "Cancel" }).click()
    await expect(page.getByText("Crash on click")).toHaveCount(0)
  })

  test("Given a parent item and a subitem, when the subitem is moved to another parent, then the hierarchy updates correctly", async ({ page }) => {
    await page.goto("/")

    await page.getByRole("button", { name: "Workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await dialog.getByLabel("Title").fill("Feature Planning")

    await dialog.getByRole("button", { name: "Create" }).click()

    // Create Parent A in To do
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    let itemForm = page.getByRole("dialog", { name: "Item details" })
    await itemForm.getByLabel("Title *").fill("Parent A")
    await itemForm.getByRole("button", { name: "Save item" }).click()

    // Create Parent B in To do
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    itemForm = page.getByRole("dialog", { name: "Item details" })
    await itemForm.getByLabel("Title *").fill("Parent B")
    await itemForm.getByRole("button", { name: "Save item" }).click()

    // Add Child 1 under Parent A
    await page.getByRole("button", { name: "Open Parent A" }).click()
    await page.getByRole("button", { name: "+ Add subitem" }).click()
    itemForm = page.getByRole("dialog", { name: "Item details" })
    await itemForm.getByLabel("Title *").fill("Child 1")
    await itemForm.getByRole("button", { name: "Save item" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()

    // Move Child 1 from Parent A to Parent B
    await page.getByRole("button", { name: "Open Parent A" }).click()
    await page.getByRole("button", { name: "Move Child 1" }).click()
    const moveDialog = page.getByRole("dialog", { name: "Move item" })
    await moveDialog.getByLabel("New parent").selectOption({ label: "Parent B" })
    await moveDialog.getByRole("button", { name: "Confirm move" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()

    // Verify Child 1 is no longer under Parent A but is under Parent B
    await page.getByRole("button", { name: "Open Parent A" }).click()
    await expect(page.getByText("Child 1")).toHaveCount(0)
    await page.getByRole("button", { name: "Close detail" }).click()

    await page.getByRole("button", { name: "Open Parent B" }).click()
    await expect(page.getByText("Child 1")).toBeVisible()
  })

  test("Gate A evidence: Reading board with Author field and nested item alongside Job search, with reload and export", async ({ page }) => {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)

    // 1. On default Job search board, create a lead
    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    await page.getByLabel("Company *").fill("Stripe")
    await page.getByLabel("Role *").fill("Platform Engineer")
    await page.getByRole("button", { name: "Create item" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(page.getByRole("button", { name: "Open Stripe — Platform Engineer" })).toBeVisible()

    // 2. Create Reading board workspace
    await page.getByRole("button", { name: "Workspaces" }).click()
    await page.getByRole("button", { name: "New workspace" }).click()
    const dialog = page.getByRole("dialog", { name: "Create workspace" })
    await dialog.getByLabel("Title").fill("Reading board")

    await dialog.getByRole("button", { name: "Create" }).click()

    await expect(page.getByRole("heading", { name: "Reading board" })).toBeVisible()
    // Verify no job search columns or lead cards leaked
    await expect(page.getByRole("button", { name: "Open Stripe — Platform Engineer" })).toHaveCount(0)

    // 3. Add Author field
    await page.getByRole("button", { name: "Edit board" }).click()
    await page.getByRole("button", { name: "Edit item" }).click()
    const settings = page.getByRole("dialog", { name: "Edit item" })
    await settings.getByRole("button", { name: "+ Add field" }).click()
    await settings.getByLabel("Field name").fill("Author")
    await settings.getByLabel("Type").selectOption("text")
    await settings.getByRole("button", { name: "Save field" }).click()
    await settings.getByRole("button", { name: "Review changes" }).click()
    await page.getByRole("dialog", { name: "Review schema changes" }).getByRole("button", { name: "Confirm apply" }).click()
    await page.getByRole("button", { name: "Done" }).click()

    // 4. Create item "Dune" with Author "Frank Herbert"
    await page.getByRole("button", { name: /Add item to/ }).first().click()
    let itemForm = page.getByRole("dialog", { name: "Item details" })
    await itemForm.getByLabel("Title *").fill("Dune")
    await itemForm.getByLabel("Author").fill("Frank Herbert")
    await itemForm.getByRole("button", { name: "Save item" }).click()
    await expect(page.getByText("Dune")).toBeVisible()

    // 5. Add nested item "Chapter 1" under "Dune"
    await page.getByRole("button", { name: "Open Dune" }).click()
    await page.getByRole("button", { name: "+ Add subitem" }).click()
    itemForm = page.getByRole("dialog", { name: "Item details" })
    await itemForm.getByLabel("Title *").fill("Chapter 1")
    await itemForm.getByRole("button", { name: "Save item" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()

    // 6. Verify reload preserves Reading board, Author field value, and nested item
    await page.reload()
    await expect(page.getByRole("heading", { name: "Reading board" })).toBeVisible()
    await expect(page.getByText("Dune")).toBeVisible()
    await page.getByRole("button", { name: "Open Dune" }).click()
    await expect(page.getByText("Chapter 1")).toBeVisible()
    await page.getByRole("button", { name: "Close detail" }).click()

    // 7. Switch back to Job search board
    await page.getByRole("button", { name: "Workspaces" }).click()
    const wsDialog = page.getByRole("dialog", { name: "Workspaces" })
    await wsDialog.locator(".workspace-switch").filter({ hasText: "Job search" }).click()
    await expect(page.getByRole("region", { name: "Job search" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open Stripe — Platform Engineer" })).toBeVisible()

    // 8. Switch back to Reading board and export
    await page.getByRole("button", { name: "Workspaces" }).click()
    await wsDialog.locator(".workspace-switch").filter({ hasText: "Reading board" }).click()
    await expect(page.getByRole("heading", { name: "Reading board" })).toBeVisible()

    const downloadPromise = page.waitForEvent("download")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const syncDialog = page.getByRole("dialog", { name: "Device sync" })
    await syncDialog.getByRole("button", { name: "Add someone" }).click()
    await syncDialog.getByRole("button", { name: "Export .tincanban" }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toContain(".tincanban")
  })
})
