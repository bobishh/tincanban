import { expect, test } from "./support/coverage"

test.describe("Agent guide", () => {
  test("Given current tincanban, when an agent opens the guide, then workspace and MCP instructions match the live contract", async ({ page }) => {
    await page.goto("/agent/")

    await expect(page.getByRole("heading", { level: 1, name: "tincanban agent guide" })).toBeVisible()
    await expect(page.getByRole("banner")).toContainText("TINCANBAN")
    await expect(page.getByRole("banner")).not.toContainText("jobs")

    const guide = page.getByRole("main")
    for (const tool of [
      "list_workspaces", "switch_workspace", "create_workspace", "rename_workspace", "get_workspace",
      "list_items", "get_entity", "rename_entity", "create_column", "get_sync_trace", "send_chat_message",
      "get_workspace_settings",
      "apply_workspace_settings",
      "create_item",
      "patch_item",
      "move_entity",
      "set_item_archived",
      "list_archived_items",
      "restore_and_move",
      "list_placement_issues",
    ]) {
      await expect(guide.locator(".tool-name", { hasText: new RegExp(`^${tool}$`) })).toHaveText(tool)
    }

    await expect(guide).toContainText("documentTemplates")
    await expect(guide).toContainText("employee_profile")
    await expect(guide).toContainText("settings.json")
    await expect(guide).toContainText("Public board")
    await expect(guide).toContainText("8 retained objects")
    await expect(guide).toContainText("expectedHeads")
    await expect(guide).toContainText("Archive")
    await expect(guide).toContainText("current workspace")
    await expect(guide).toContainText("Add my device")
    await expect(guide.getByText("move_item", { exact: true })).toHaveCount(0)
    await expect(guide).not.toContainText("global CV and cover-letter")
    await expect(guide.getByRole("heading", { name: "Job-search compatibility tools" })).toHaveCount(0)
    for (const removedAlias of [
      "list_leads", "create_lead", "move_lead", "list_templates", "get_generation_context",
      "record_pdf_artifact", "add_document", "export_workspace",
    ]) await expect(guide.getByText(removedAlias, { exact: true })).toHaveCount(0)
  })

  test("Given invalid or stale settings, when an agent follows recovery guidance, then validation and conflict behavior is explicit", async ({ page }) => {
    await page.goto("/agent/")

    const safety = page.getByRole("heading", { name: "Mutation rules" }).locator("..")
    await expect(safety).toContainText("Unknown fields are rejected without mutation")
    await expect(safety).toContainText("re-read settings")
    await expect(safety).toContainText("conflict")
    await expect(safety).toContainText("Keep returned IDs")
  })

  test("Given a narrow viewport, when the guide opens, then content remains within the viewport", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto("/agent/")

    await expect(page.getByRole("heading", { level: 1 })).toBeVisible()
    const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    expect(hasHorizontalOverflow).toBe(false)
  })
})
