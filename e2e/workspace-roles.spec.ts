import { expect, test } from "./support/coverage"
import { faviconRole } from "./support/favicon"
import { ensureJobSearchWorkspace } from "./support/workspaces"

for (const role of ["visitor", "editor"] as const) {
  test(`Given an owner and pending guest, when approved as ${role}, then role controls writes and board settings`, async ({ page, browser }) => {
    test.setTimeout(60000)
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(page.getByLabel("Mesh empty")).toBeVisible()
    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    await page.getByLabel("Company *").fill("Role test")
    await page.getByLabel("Role *").fill("Engineer")
    await page.getByRole("button", { name: "Create item" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const host = page.getByRole("dialog", { name: "Device sync" })
    await host.getByRole("button", { name: "Add someone" }).click()
    await host.getByRole("button", { name: "Generate link" }).click()
    const context = await browser.newContext()
    try {
      const guest = await context.newPage()
      await guest.goto(await host.getByLabel("Pairing link").inputValue())
      const dialog = guest.getByRole("dialog", { name: "Device sync" })
      await dialog.getByRole("button", { name: "Accept and join" }).click()
      await expect(host.getByRole("region", { name: "Access request" })).toContainText("wants to join")
      await expect(host.getByLabel("Participant role")).toHaveValue("visitor")
      await expect(dialog.getByText(/Connected to/)).toHaveCount(0)
      await host.getByLabel("Participant role").selectOption(role)
      await host.getByRole("button", { name: "Approve access" }).click()
      await expect(dialog.getByText(/Connected to/)).toBeVisible({ timeout: 25000 })
      await dialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await host.getByRole("button", { name: "Close", exact: true }).first().click()
      await expect(guest.getByLabel(`Workspace role: ${role}`)).toBeVisible()
      await expect(guest.locator(`.can-role-stamp[data-role-stamp="${role}"]`)).toBeVisible()
      const sharedWorkspaceId = await guest.evaluate(async () => (await import("/src/test/stateFixture.ts")).useTincanban().activeWorkspace.id)
      await expect.poll(() => faviconRole(guest)).toEqual({ role, body: role === "editor" ? "#80b9d8" : "#c8c9cb" })
      if (role === "editor") {
        const structuralMove = await guest.evaluate(async () => {
          const state = (await import("/src/test/stateFixture.ts")).useTincanban()
          const column = state.genericColumns.value[0]!
          try { await state.executeCommandAsync({ kind: "moveEntity", entityId: column.id, parentId: column.placement.parentId, beforeId: null }); return "allowed" }
          catch (error) { return String(error) }
        })
        expect(structuralMove).toContain("Only the owner can edit board structure")
      }
      await guest.getByRole("button", { name: "Settings", exact: true }).click()
      const guestSettings = guest.getByRole("dialog", { name: "Settings", exact: true })
      await expect(guestSettings.getByRole("tab", { name: "Identity", exact: true })).toBeVisible()
      await expect(guestSettings.getByRole("tab", { name: "Workspace", exact: true })).toBeVisible()
      await expect(guestSettings.getByRole("tab", { name: "Your profile", exact: true })).toHaveCount(0)
      await guestSettings.getByRole("tab", { name: "Identity", exact: true }).click()
      await guestSettings.getByLabel("Name", { exact: true }).fill(`${role} identity`)
      await guestSettings.getByRole("button", { name: "Save profile", exact: true }).click()
      await expect(guestSettings.getByLabel("Name", { exact: true })).toHaveValue(`${role} identity`)
      await expect(guestSettings.getByRole("button", { name: "Recovery backup", exact: true })).toHaveCount(0)
      await guestSettings.getByRole("tab", { name: "Workspace", exact: true }).click()
      await guestSettings.getByText("settings.json", { exact: true }).click()
      const workspaceJson = guestSettings.getByLabel("Workspace settings JSON", { exact: true })
      if (role === "visitor") {
        await expect(workspaceJson).toHaveAttribute("readonly", "")
        await expect(guestSettings.getByRole("button", { name: "Apply JSON", exact: true })).toBeDisabled()
      }
      await guestSettings.getByRole("button", { name: "Dismiss", exact: true }).click()
      await expect(guest.getByRole("button", { name: "Edit board", exact: true })).toHaveCount(0)
      await guest.getByRole("button", { name: "Open workspaces" }).click()
      const workspaces = guest.getByRole("dialog", { name: "Workspaces" })
      const activeWorkspace = workspaces.locator(`.workspace-item[data-workspace-id="${sharedWorkspaceId}"]`)
      await expect(activeWorkspace).toHaveClass(/workspace-item-active/, { timeout: 30_000 })
      if (role === "editor") await expect(activeWorkspace.getByRole("button", { name: "Rename", exact: true })).toBeVisible({ timeout: 30_000 })
      else await expect(activeWorkspace.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0)
      await workspaces.getByRole("button", { name: "Close", exact: true }).last().click()
      await guest.getByRole("button", { name: "Sync", exact: true }).click()
      const guestSync = guest.getByRole("dialog", { name: "Device sync" })
      await expect(guestSync.getByRole("button", { name: "Import .tincanban" })).toHaveCount(0)
      await guestSync.getByRole("button", { name: "Close", exact: true }).first().click()
      const rejection = await guest.evaluate(async () => {
        const { useTincanban } = await import('/src/state.ts')
        const state = useTincanban()
        try { await state.executeCommandAsync({ kind: 'renameWorkspace', title: 'editor renamed' }); return 'allowed' }
        catch (error) { return String(error) }
      })
      if (role === 'visitor') expect(rejection).toContain('Visitors can only view')
      else expect(rejection).toBe('allowed')
      if (role === "visitor") {
        await expect(guest.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
        await guest.getByRole("button", { name: "Open Role test — Engineer" }).click()
        await expect(guest.locator('.status-strip button').first()).toBeDisabled()
      } else {
        await guest.getByRole("button", { name: "Open Role test — Engineer" }).click()
        await guest.locator('.status-strip button').filter({ hasText: 'Interview' }).click()
        await expect(page.getByRole("region", { name: "Interview", exact: true }).getByRole("button", { name: "Open Role test — Engineer" })).toBeVisible({ timeout: 15000 })
      }
      await guest.reload()
      await expect(guest.getByLabel(`Workspace role: ${role}`)).toBeVisible()
    } finally { await context.close() }
  })
}

test("Given a pending access request, when the owner declines, then no shared workspace arrives", async ({ page, browser }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const host = page.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Generate link" }).click()
  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Accept and join" }).click()
    await expect(host.getByLabel("Participant role")).toHaveValue("visitor")
    await host.getByRole("button", { name: "Decline", exact: true }).click()
    await expect(dialog.getByRole("alert")).toContainText("declined")
    await expect(dialog.getByText(/Connected to/)).toHaveCount(0)
  } finally { await context.close() }
})

test("Given another browser uses the owner's identity, when it opens an editor invite, then tincanban explains the identity conflict before approval", async ({ page, browser }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const ownerProfile = await page.evaluate(async () => (await import("/src/localDb.ts")).readLocal("tincanban.local_profile.v1"))
  expect(ownerProfile).toBeTruthy()
  const host = page.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Generate link" }).click()
  const invite = await host.getByLabel("Pairing link").inputValue()
  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto("/")
    await expect(guest.getByLabel("Workspace role: owner")).toBeVisible()
    await guest.evaluate(async profile => (await import("/src/localDb.ts")).writeLocal("tincanban.local_profile.v1", profile), ownerProfile!)
    await guest.goto(invite)
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Accept and join" }).click()
    await expect(dialog.getByRole("alert")).toContainText("This invite is for another person")
    await expect(dialog.getByRole("alert")).toContainText("separate identity")
    await expect(host.getByRole("region", { name: "Access request" })).toHaveCount(0)
  } finally { await context.close() }
})

test("Given snapshot preparation fails, when an editor is approved, then both devices see one terminal cause", async ({ page, browser }) => {
  test.setTimeout(60_000)
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const host = page.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Generate link" }).click()
  const invite = await host.getByLabel("Pairing link").inputValue()

  await page.evaluate(() => {
    ;(window as Window & { __TINCANBAN_INJECT_SYNC_SNAPSHOT_FAILURE__?: string }).__TINCANBAN_INJECT_SYNC_SNAPSHOT_FAILURE__ =
      "E2E snapshot preparation failure"
  })

  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto(invite)
    const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
    await guestDialog.getByRole("button", { name: "Accept and join" }).click()
    await expect(host.getByLabel("Participant role")).toHaveValue("visitor")
    await host.getByLabel("Participant role").selectOption("editor")
    await host.getByRole("button", { name: "Approve access" }).click()

    const snapshotError = /E2E snapshot preparation failure/i
    await expect(guestDialog.getByRole("alert")).toContainText(snapshotError, { timeout: 25_000 })
    await expect(host.getByRole("alert")).toContainText(snapshotError, { timeout: 25_000 })
    await expect(guestDialog.getByText(/Connected to/)).toHaveCount(0)
    await expect(page.getByLabel("Participant role")).toHaveCount(0)
    await page.waitForTimeout(1_000)
    await expect(guestDialog.getByRole("alert")).toHaveCount(1)
    await expect(guest).toHaveURL(invite)
  } finally { await context.close() }
})
