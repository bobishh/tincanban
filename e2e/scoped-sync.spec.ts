import { expect, test, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

function stored(page: Page, key = "tincanban.local_profile.v1") {
  return page.evaluate(async name => (await import("/src/localDb.ts")).readLocal(name), key)
}

async function profile(page: Page) {
  return JSON.parse((await stored(page))!) as { identity: { personId: string }; device: { deviceId: string } }
}

test.describe("Scoped Sync Outer Scenarios", () => {
  test("Given Sync is opened, when user selects Sync all (Add my device), then it requires mutual approval and displays authentication code before completing enrollment", async ({ browser, page }) => {
    test.setTimeout(120_000)
    const secondContext = await browser.newContext()
    const secondPage = await secondContext.newPage()

    try {
      await page.goto("/")
      await ensureJobSearchWorkspace(page)
      await page.getByRole("button", { name: /Add lead to/ }).first().click()
      await page.getByLabel("Company *").fill("Enrollment proof")
      await page.getByLabel("Role *").fill("Engineer")
      await page.getByRole("button", { name: "Create item" }).click()
      await page.getByRole("button", { name: "Close detail" }).click()
      await page.getByRole("button", { name: "Sync", exact: true }).click()

      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      // Choose "Sync all" ("Add my device")
      await hostDialog.getByRole("button", { name: "Add someone" }).click()
      await hostDialog.getByRole("button", { name: "Add my device", exact: true }).click()

      // Should show enrollment invitation link / QR
      await expect(hostDialog.getByText("Add your second device")).toBeVisible()
      await expect(hostDialog.getByRole("button", { name: "Copy enrollment link" })).toBeVisible()
      await expect(hostDialog.getByRole("button", { name: "Copy pairing link" })).toHaveCount(0)
      const inviteLink = await hostDialog.getByLabel("Pairing link").inputValue()

      await hostDialog.getByRole("button", { name: "Close", exact: true }).click()
      await page.getByRole("button", { name: "Sync", exact: true }).click()
      await expect(hostDialog.getByLabel("Pairing link")).toHaveValue(inviteLink)

      await expect(hostDialog.getByRole("button", { name: "Approve device" })).toHaveCount(0)

      // Second device opens invitation
      await secondPage.goto(inviteLink)
      const secondDialog = secondPage.getByRole("dialog", { name: "Device sync" })
      await expect(secondDialog.getByRole("heading", { name: "Add your device" })).toBeVisible()
      const guestBootstrapId = await secondPage.evaluate(async () => {
        const { whenReady } = await import("/src/statePersistence.ts")
        const { useTincanban } = await import("/src/state.ts")
        await whenReady()
        return useTincanban().activeWorkspace.id
      })
      expect(guestBootstrapId).toBeTruthy()

      // Target device starts pairing and enters waiting approval state
      await secondDialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
      if (await secondDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await secondDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
      await secondDialog.getByRole("button", { name: "Add this device" }).click()
      await expect(secondDialog.getByText("Waiting for approval")).toBeVisible()

      await expect(secondPage.getByRole("button", { name: "Open Enrollment proof — Engineer" })).toHaveCount(0)
      const beforeApproval = await secondPage.evaluate(async () => {
        const { useTincanban } = await import("/src/state.ts")
        return useTincanban().availableWorkspaces.value.map(workspace => workspace.id)
      })
      expect(beforeApproval).toContain(guestBootstrapId)
      const hostWorkspaceId = await page.evaluate(async () => {
        const { useTincanban } = await import("/src/state.ts")
        return useTincanban().activeWorkspace.id
      })
      expect(beforeApproval).not.toContain(hostWorkspaceId)
      await expect(hostDialog.getByLabel("Participant role")).toHaveCount(0)

      // Both devices show the matching authentication code
      const authCodeHost = await hostDialog.locator(".auth-code").innerText()
      const authCodeTarget = await secondDialog.locator(".auth-code").innerText()
      expect(authCodeHost).toBeTruthy()
      expect(authCodeHost).toEqual(authCodeTarget)

      // Host approves second device
      await hostDialog.getByRole("button", { name: "Approve device" }).click()

      // Both devices become connected
      await expect.poll(async () => {
        const failure = await secondDialog.getByRole("alert").textContent({ timeout: 100 }).catch(() => null)
        return failure || await secondDialog.getByText("Device enrolled", { exact: true }).count()
      }, { timeout: 15000 }).toBe(1)
      await expect(hostDialog.getByText("Device enrolled")).toBeVisible()
      await secondDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await expect(secondPage.getByRole("button", { name: "Open Enrollment proof — Engineer" })).toBeVisible()
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible()
      const afterApproval = await secondPage.evaluate(async () => {
        const { useTincanban } = await import("/src/state.ts")
        return {
          activeId: useTincanban().activeWorkspace.id,
          availableIds: useTincanban().availableWorkspaces.value.map(workspace => workspace.id),
        }
      })
      expect(afterApproval.activeId).toBe(hostWorkspaceId)
      expect(afterApproval.availableIds).toContain(hostWorkspaceId)
      expect(afterApproval.availableIds).not.toContain(guestBootstrapId)
      const oldDocumentPreserved = await secondPage.evaluate(async (oldId: string) => {
        const { defaultStorage } = await import("/src/storage.ts")
        return Boolean(await defaultStorage.loadWorkspaceDoc(oldId))
      }, guestBootstrapId)
      expect(oldDocumentPreserved).toBe(true)
      const identity = async (target: Page) => (await profile(target)).identity.personId
      expect(await identity(secondPage)).toBe(await identity(page))
      await secondPage.reload()
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible()
      await expect(secondPage.getByRole("button", { name: "Open Enrollment proof — Engineer" })).toBeVisible()
      const afterReloadIds = await secondPage.evaluate(async () => {
        const { useTincanban } = await import("/src/state.ts")
        return useTincanban().availableWorkspaces.value.map(workspace => workspace.id)
      })
      expect(afterReloadIds).toContain(hostWorkspaceId)
      expect(afterReloadIds).not.toContain(guestBootstrapId)
      await expect(secondPage.getByLabel("Mesh connected")).toBeVisible({ timeout: 60_000 })
      await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 60_000 })
      await secondPage.getByRole("button", { name: /Add lead to/ }).first().click()
      await secondPage.getByLabel("Company *").fill("After reload")
      await secondPage.getByLabel("Role *").fill("Engineer")
      await secondPage.getByRole("button", { name: "Create item" }).click()
      await expect(page.getByRole("button", { name: "Open After reload — Engineer" })).toBeVisible({ timeout: 20000 })

    } finally {
      await secondContext.close()
    }
  })

  test("Given an enrolled device deletes its final workspace, when tincanban creates the fallback, then the enrolled device remains its owner after reload", async ({ browser, page }) => {
    test.setTimeout(120_000)
    const secondContext = await browser.newContext()
    const secondPage = await secondContext.newPage()

    try {
      await page.goto("/")
      await page.getByRole("button", { name: "Sync", exact: true }).click()
      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      await hostDialog.getByRole("button", { name: "Add someone" }).click()
      await hostDialog.getByRole("button", { name: "Add my device", exact: true }).click()

      await secondPage.goto(await hostDialog.getByLabel("Pairing link").inputValue())
      const secondDialog = secondPage.getByRole("dialog", { name: "Device sync" })
      await secondDialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
      // Identity replacement preserves local boards. Archive the guest's bootstrap board
      // under its original identity so this scenario reaches the enrolled owner's final board.
      await secondPage.evaluate(async () => {
        const { useTincanban } = await import("/src/state.ts")
        const { defaultStorage } = await import("/src/storage.ts")
        const { commitAndPersist, refreshAvailableWorkspaces, whenReady } = await import("/src/statePersistence.ts")
        const tincanban = useTincanban()
        await whenReady()
        if (!tincanban.activeWorkspace.id) throw new Error("Guest bootstrap workspace missing")
        await commitAndPersist({ kind: "setWorkspaceArchived", archived: true }, defaultStorage)
        await refreshAvailableWorkspaces(defaultStorage)
      })
      if (await secondDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await secondDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
      await secondDialog.getByRole("button", { name: "Add this device" }).click()
      await hostDialog.getByRole("button", { name: "Approve device" }).click()
      await expect(hostDialog.getByText("Device enrolled")).toBeVisible()
      await expect(secondDialog.getByText("Device enrolled")).toBeVisible()
      await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await secondDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible()

      await secondPage.getByRole("button", { name: "Open workspaces" }).click()
      const workspaces = secondPage.getByRole("dialog", { name: "Workspaces" })
      const archivedWorkspaceIds = await secondPage.evaluate(async () => {
        const { useTincanban } = await import("/src/state.ts")
        return useTincanban().availableWorkspaces.value.map(workspace => workspace.id)
      })
      await expect(workspaces).toBeVisible()
      expect(archivedWorkspaceIds).toHaveLength(1)
      await expect(workspaces.locator(".workspace-item")).toHaveCount(archivedWorkspaceIds.length)
      for (const workspaceId of archivedWorkspaceIds) {
        const workspace = workspaces.locator(`.workspace-item[data-workspace-id="${workspaceId}"]`)
        await workspace.getByRole("button", { name: "Archive", exact: true }).click()
        await workspace.getByRole("button", { name: "Archive workspace", exact: true }).click()
        await expect(workspace).toHaveCount(0)
      }

      await workspaces.getByRole("button", { name: "Close", exact: true }).last().click()
      await expect(secondPage.getByRole("heading", { name: "TINCANBAN // Untitled" })).toBeVisible()
      await expect.poll(async () => secondPage.evaluate(async () => {
        const { useTincanban } = await import("/src/state.ts")
        return useTincanban().activeWorkspace.id
      }).then(id => archivedWorkspaceIds.includes(id))).toBe(false)
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 30_000 })
      const fallbackId = await secondPage.evaluate(async () => {
        const { useTincanban } = await import("/src/state.ts")
        return useTincanban().activeWorkspace.id
      })
      expect(archivedWorkspaceIds).not.toContain(fallbackId)
      await secondPage.reload()
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 30_000 })
      await expect.poll(async () => secondPage.evaluate(async () => {
        const { useTincanban } = await import("/src/state.ts")
        return useTincanban().activeWorkspace.id
      })).toBe(fallbackId)
    } finally {
      await secondContext.close()
    }
  })

  test("Given Sync is opened, when active workspace is preselected, then Generate link creates a usable single-workspace invite without extra navigation", async ({ browser, page }) => {
    const guestContext = await browser.newContext()
    const guestPage = await guestContext.newPage()

    try {
      await page.goto("/")
      await ensureJobSearchWorkspace(page)
      await page.getByRole("button", { name: "Sync", exact: true }).click()

      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      await hostDialog.getByRole("button", { name: "Add someone" }).click()
      // Active workspace "Job search" is already preselected
      await expect(hostDialog.getByLabel("Job search")).toBeChecked()
      // Directly click Generate link without preliminary chooser or dropdown navigation
      await hostDialog.getByRole("button", { name: "Generate link" }).click()

      const inviteLink = await hostDialog.getByLabel("Pairing link").inputValue()

      // Guest visits the link
      await guestPage.goto(inviteLink)
      const guestDialog = guestPage.getByRole("dialog", { name: "Device sync" })
      await expect(guestDialog.getByRole("heading", { name: "Join workspace" })).toBeVisible()
      await expect(guestDialog.getByText("You have been invited to join Job search")).toBeVisible()

      // Explicit acceptance
      await guestDialog.getByRole("button", { name: "Accept and join" }).click()
      await page.getByLabel("Participant role").selectOption("editor")
      await page.getByRole("button", { name: "Approve access" }).click()
      await expect(guestDialog.getByText("Connected to Job search")).toBeVisible()
    } finally {
      await guestContext.close()
    }
  })

  test("Given multiple workspaces, when user selects A+B, then one invitation is generated for both, recipient sees both names on acceptance, and both connect", async ({ browser, page }) => {
    const guestContext = await browser.newContext()
    const guestPage = await guestContext.newPage()

    try {
      await page.goto("/")
      await ensureJobSearchWorkspace(page)
      // Create a second workspace "Reading list"
      await page.getByRole("button", { name: "Workspaces" }).click()
      await page.getByRole("button", { name: "New workspace" }).click()
      const createDialog = page.getByRole("dialog", { name: "Create workspace" })
      await createDialog.getByLabel("Title").fill("Reading list")
      await createDialog.getByRole("button", { name: "Create" }).click()

      // Open Sync
      await page.getByRole("button", { name: "Sync", exact: true }).click()
      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      await hostDialog.getByRole("button", { name: "Add someone" }).click()

      // Active workspace "Reading list" is preselected; check "Job search" too
      await expect(hostDialog.getByLabel("Reading list")).toBeChecked()
      await hostDialog.getByLabel("Job search").check()
      expect(await hostDialog.getByLabel("Reading list").isChecked()).toBe(true)
      expect(await hostDialog.getByLabel("Job search").isChecked()).toBe(true)

      // Generate single invitation for the fixed set
      await hostDialog.getByRole("button", { name: "Generate link" }).click()
      const inviteLink = await hostDialog.getByLabel("Pairing link").inputValue()

      // Guest visits link
      await guestPage.goto(inviteLink)
      const guestDialog = guestPage.getByRole("dialog", { name: "Device sync" })
      await expect(guestDialog.getByRole("heading", { name: "Join workspace" })).toBeVisible()
      // Recipient acceptance displays selected names
      await expect(guestDialog.locator("li", { hasText: "Reading list" })).toBeVisible()
      await expect(guestDialog.locator("li", { hasText: "Job search" })).toBeVisible()

      await guestDialog.getByRole("button", { name: "Accept and join" }).click()
      await page.getByLabel("Participant role").selectOption("editor")
      await page.getByRole("button", { name: "Approve access" }).click()
      await expect(guestDialog.getByText(/Connected to/i)).toBeVisible()
    } finally {
      await guestContext.close()
    }
  })

  test("Given Sync is opened, when all workspaces are deselected, then Generate link is disabled", async ({ page }) => {
    await page.goto("/")
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const hostDialog = page.getByRole("dialog", { name: "Device sync" })
    await hostDialog.getByRole("button", { name: "Add someone" }).click()

    // Active workspace is initially checked
    const checkbox = hostDialog.getByLabel("Untitled")
    await expect(checkbox).toBeChecked()
    await expect(hostDialog.getByRole("button", { name: "Generate link" })).toBeEnabled()

    // Uncheck it -> empty selection disables generation
    await checkbox.uncheck()
    await expect(checkbox).not.toBeChecked()
    await expect(hostDialog.getByRole("button", { name: "Generate link" })).toBeDisabled()
  })

  test("Given enrolled devices, when either device reloads, then it retains durable trust without requiring another QR", async ({ browser, page }) => {
    test.setTimeout(120_000)
    const secondContext = await browser.newContext()
    const secondPage = await secondContext.newPage()

    try {
      await page.goto("/")
      await page.getByRole("button", { name: "Sync", exact: true }).click()
      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      await hostDialog.getByRole("button", { name: "Add someone" }).click()
      await hostDialog.getByRole("button", { name: "Add my device", exact: true }).click()

      const inviteLink = await hostDialog.getByLabel("Pairing link").inputValue()

      await secondPage.goto(inviteLink)
      const secondDialog = secondPage.getByRole("dialog", { name: "Device sync" })
      await secondDialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
      if (await secondDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await secondDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
      await secondDialog.getByRole("button", { name: "Add this device" }).click()
      await hostDialog.getByRole("button", { name: "Approve device" }).click()

      await expect(hostDialog.getByText("Device enrolled")).toBeVisible()
      await expect(secondDialog.getByText("Device enrolled")).toBeVisible()

      const identity = (await profile(secondPage)).identity.personId
      await secondPage.reload()
      await expect(secondPage.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible()
      await page.reload()
      await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
      await secondContext.setOffline(true)
      await secondPage.evaluate(() => window.dispatchEvent(new Event("offline")))
      await expect(secondPage.getByLabel("Mesh offline")).toBeVisible({ timeout: 15_000 })
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible()
      await secondContext.setOffline(false)
      await secondPage.evaluate(() => window.dispatchEvent(new Event("online")))
      await expect(secondPage.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
      expect((await profile(secondPage)).identity.personId).toBe(identity)
    } finally {
      await secondContext.close()
    }
  })

  test("Given enrolled devices share several workspaces, when one device reloads, then the other stays connected and receives its next edit", async ({ browser, page }) => {
    test.setTimeout(150_000)
    const secondContext = await browser.newContext()
    const secondPage = await secondContext.newPage()

    try {
      await page.goto("/")
      for (const title of ["Alpha", "Bravo", "Charlie", "Delta"]) {
        await page.getByRole("button", { name: "Open workspaces" }).click()
        await page.getByRole("button", { name: "New workspace" }).click()
        const create = page.getByRole("dialog", { name: "Create workspace" })
        await create.getByLabel("Title").fill(title)
        await create.getByRole("radio", { name: "Blank board" }).check()
        await create.getByRole("button", { name: "Create" }).click()
      }

      await page.getByRole("button", { name: "Sync", exact: true }).click()
      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      await hostDialog.getByRole("button", { name: "Add someone" }).click()
      await hostDialog.getByRole("button", { name: "Add my device", exact: true }).click()
      await secondPage.goto(await hostDialog.getByLabel("Pairing link").inputValue())
      const secondDialog = secondPage.getByRole("dialog", { name: "Device sync" })
      await secondDialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
      if (await secondDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await secondDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
      await secondDialog.getByRole("button", { name: "Add this device" }).click()
      await hostDialog.getByRole("button", { name: "Approve device" }).click()
      await expect(hostDialog.getByText("Device enrolled")).toBeVisible({ timeout: 30_000 })
      await expect(secondDialog.getByText("Device enrolled")).toBeVisible({ timeout: 30_000 })
      await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await secondDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 45_000 })
      await expect(secondPage.getByLabel("Mesh connected")).toBeVisible({ timeout: 45_000 })

      await page.reload()
      await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 45_000 })
      await expect(secondPage.getByLabel("Mesh connected")).toBeVisible({ timeout: 45_000 })
      await page.getByRole("button", { name: /Add item to/ }).first().click()
      const item = page.getByRole("dialog", { name: "Item details" })
      await item.getByLabel("Title *").fill("After one-sided reload")
      await item.getByRole("button", { name: "Save item" }).click()
      await expect(secondPage.getByRole("button", { name: "Open After one-sided reload" })).toBeVisible({ timeout: 30_000 })
    } finally {
      await secondContext.close()
    }
  })

  test("Given an enrolled owner device is offline, when another device creates a workspace, then it receives the workspace after reconnecting without another invite", async ({ browser, page }) => {
    test.setTimeout(120_000)
    const secondContext = await browser.newContext()
    const secondPage = await secondContext.newPage()

    try {
      await page.goto("/")
      await page.getByRole("button", { name: "Sync", exact: true }).click()
      const hostDialog = page.getByRole("dialog", { name: "Device sync" })
      await hostDialog.getByRole("button", { name: "Add someone" }).click()
      await hostDialog.getByRole("button", { name: "Add my device", exact: true }).click()

      await secondPage.goto(await hostDialog.getByLabel("Pairing link").inputValue())
      const secondDialog = secondPage.getByRole("dialog", { name: "Device sync" })
      await secondDialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
      if (await secondDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await secondDialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
      await secondDialog.getByRole("button", { name: "Add this device" }).click()
      await hostDialog.getByRole("button", { name: "Approve device" }).click()
      await expect(hostDialog.getByText("Device enrolled")).toBeVisible()
      await expect(secondDialog.getByText("Device enrolled")).toBeVisible()
      await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await secondDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await expect(secondPage.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })

      await secondContext.setOffline(true)
      await secondPage.evaluate(() => window.dispatchEvent(new Event("offline")))
      await expect(secondPage.getByLabel("Mesh offline")).toBeVisible({ timeout: 15_000 })

      await page.getByRole("button", { name: "Open workspaces" }).click()
      await page.getByRole("button", { name: "New workspace" }).click()
      const createDialog = page.getByRole("dialog", { name: "Create workspace" })
      await createDialog.getByLabel("Title").fill("Future plans")
      await createDialog.getByRole("button", { name: "Create" }).click()

      await secondContext.setOffline(false)
      await secondPage.evaluate(() => window.dispatchEvent(new Event("online")))
      await expect(secondPage.getByLabel("Mesh connected")).toBeVisible({ timeout: 45_000 })
      await secondPage.getByRole("button", { name: "Open workspaces" }).click()
      const futurePlans = secondPage.locator(".workspace-item").filter({
        has: secondPage.locator(".workspace-switch strong", { hasText: /^Future plans$/ }),
      })
      await expect(futurePlans).toHaveCount(1, { timeout: 30_000 })
      await futurePlans.locator(".workspace-switch").click()
      await expect(secondPage.getByRole("heading", { name: "Future plans" })).toBeVisible()
      await expect(secondPage.getByLabel("Workspace role: owner")).toBeVisible()
    } finally {
      await secondContext.close()
    }
  })
})


test("Given a real pending device request, when declined, then guest sees refusal and keeps its identity", async ({ page, browser }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const host = page.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Add my device", exact: true }).click()
  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    await expect.poll(() => stored(guest)).not.toBeNull()
    const originalProfile = await stored(guest)
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
    if (await dialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await dialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
    await dialog.getByRole("button", { name: "Add this device" }).click()
    await host.getByRole("button", { name: "Decline device" }).click()
    await expect(dialog.getByRole("alert")).toContainText("declined")
    await expect(host.getByRole("alert")).toContainText("declined")
    expect(await stored(guest)).toBe(originalProfile)
    await expect(dialog.getByText("Device enrolled", { exact: true })).toHaveCount(0)
  } finally { await context.close() }
})

test("Given approved enrollment but failed storage, when receiving identity, then both devices report failure without claiming success", async ({ page, browser }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const host = page.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Add my device", exact: true }).click()
  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await expect(dialog.getByRole("button", { name: "Add this device" })).toBeVisible()
    const original = await stored(guest)
    await guest.evaluate(async () => {
      // Identity adoption now commits in the local-state transaction; fail that
      // actual write, rather than the later workspace projection.
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function(value: unknown, key?: IDBValidKey) {
        if (this.name === "kv" && key === "tincanban.local_profile.v1") {
          throw new DOMException("Identity storage failure injected", "QuotaExceededError")
        }
        return put.call(this, value, key)
      }
    })
    await dialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
    if (await dialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await dialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
    await dialog.getByRole("button", { name: "Add this device" }).click()
    await host.getByRole("button", { name: "Approve device" }).click()
    await expect(dialog.getByRole("alert")).toContainText(/storage|save|injected/i)
    await expect(host.getByRole("alert")).toBeVisible()
    await expect(host.getByText("Device enrolled", { exact: true })).toHaveCount(0)
    expect(await stored(guest)).toBe(original)
  } finally { await context.close() }
})

test("Given a visitor already has the owner's board, when the same device is enrolled, then the board stays and owner access survives reload", async ({ page, browser }) => {
  test.setTimeout(90_000)
  const context = await browser.newContext()
  const guest = await context.newPage()
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    await page.getByLabel("Company *").fill("Existing shared board")
    await page.getByLabel("Role *").fill("Engineer")
    await page.getByRole("button", { name: "Create item" }).click()
    await page.getByRole("button", { name: "Close detail" }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const host = page.getByRole("dialog", { name: "Device sync" })
    await host.getByRole("button", { name: "Add someone" }).click()
    await host.getByRole("button", { name: "Generate link" }).click()
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Accept and join" }).click()
    await page.getByRole("button", { name: "Approve access" }).click()
    await expect(dialog.getByText(/Connected to/)).toBeVisible()
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await host.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(guest.getByLabel("Workspace role: visitor")).toBeVisible()
    const deviceId = (await profile(guest)).device.deviceId
    await expect(page.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await host.getByRole("button", { name: "Add someone", exact: true }).click()
    await host.getByRole("button", { name: "Add my device", exact: true }).click()
    await guest.goto(await host.getByLabel("Pairing link").inputValue())
    await dialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
    if (await dialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await dialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
    await dialog.getByRole("button", { name: "Add this device" }).click()
    await host.getByRole("button", { name: "Approve device" }).click()
    await expect(dialog.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30_000 })
    await guest.reload()
    await expect(guest.getByLabel("Workspace role: owner")).toBeVisible()
    await expect(guest.getByRole("button", { name: "Open Existing shared board — Engineer" })).toBeVisible()
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    expect((await profile(guest)).device.deviceId).toBe(deviceId)
  } finally { await context.close() }
})

test("Given existing data under another identity, when enrollment is approved, then the same device keeps old data stored but hides its unentitled scope", async ({ page, browser }) => {
  test.setTimeout(90_000)
  await page.goto("/")
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const host = page.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Add my device", exact: true }).click()
  const deviceInvite = await host.getByLabel("Pairing link").inputValue()
  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto("/")
    await ensureJobSearchWorkspace(guest)
    const previousWorkspaceId = await guest.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)
    await guest.getByRole("button", { name: /Add lead to/ }).first().click()
    await guest.getByLabel("Company *").fill("Keep my data")
    await guest.getByLabel("Role *").fill("Engineer")
    await guest.getByRole("button", { name: "Create item" }).click()
    await guest.getByRole("button", { name: "Close detail" }).click()
    const previousWorkspaceBytes = await guest.evaluate(async id =>
      Array.from(await (await import("/src/state.ts")).useTincanban().readWorkspaceBytes(id)), previousWorkspaceId)
    // This identity previously enabled mesh for its own local board.
    await guest.getByRole("button", { name: "Sync", exact: true }).click()
    const oldIdentityDialog = guest.getByRole("dialog", { name: "Device sync" })
    await oldIdentityDialog.getByRole("button", { name: "Add someone" }).click()
    await oldIdentityDialog.getByRole("button", { name: "Generate link" }).click()
    await expect(oldIdentityDialog.getByLabel("Pairing link")).toHaveValue(/workspace-join/)
    const original = await stored(guest)
    await guest.goto(deviceInvite)
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
    await expect(dialog.getByRole("alert")).toContainText("Identity conflict")
    await expect(dialog.getByRole("button", { name: "Add this device" })).toBeDisabled()
    expect(await stored(guest)).toBe(original)
    if (await dialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await dialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
    await dialog.getByRole("button", { name: "Add this device" }).click()
    await expect(host.getByRole("button", { name: "Approve device" })).toBeVisible()
    expect(await stored(guest)).toBe(original)
    await host.getByRole("button", { name: "Approve device" }).click()
    await expect(dialog.getByText("Device enrolled", { exact: true })).toBeVisible()
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(guest.getByLabel("Workspace role: owner")).toBeVisible()
    const enrolled = await profile(guest)
    expect(enrolled.device.deviceId).toBe(JSON.parse(original!).device.deviceId)
    expect(enrolled.identity.personId).toBe((await profile(page)).identity.personId)
    expect(await stored(guest, `tincanban.local_profile.v1.backup.${JSON.parse(original!).identity.personId}`)).toBe(original)
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await expect(guest.getByText(/Invalid workspace grant signature/)).toHaveCount(0)
    const retainedWorkspace = await guest.evaluate(async id => {
      const { WorkspaceStorage } = await import("/src/storage.ts")
      const { isItem } = await import("/src/domain/model.ts")
      const loaded = await new WorkspaceStorage().loadWorkspaceDoc(id)
      return loaded && {
        title: loaded.doc.title,
        itemTitles: Object.values(loaded.doc.entities)
          .filter(isItem)
          .map(entity => entity.title),
      }
    }, previousWorkspaceId)
    expect(retainedWorkspace).toMatchObject({ title: "Job search", itemTitles: ["Keep my data — Engineer"] })
    const entitledWorkspaceIds = await guest.evaluate(async () =>
      (await import("/src/state.ts")).useTincanban().availableWorkspaces.value.map(workspace => workspace.id))
    expect(entitledWorkspaceIds).not.toContain(previousWorkspaceId)
    const retainedWorkspaceBytes = await guest.evaluate(async id =>
      Array.from(await (await import("/src/state.ts")).useTincanban().readWorkspaceBytes(id)), previousWorkspaceId)
    expect(retainedWorkspaceBytes).toEqual(previousWorkspaceBytes)
    await guest.getByRole("button", { name: "Open workspaces" }).click()
    const workspaces = guest.getByRole("dialog", { name: "Workspaces" })
    await expect(workspaces.locator(`.workspace-item[data-workspace-id="${previousWorkspaceId}"]`)).toHaveCount(0)
    await expect(guest.getByRole("button", { name: "Open Keep my data — Engineer" })).toHaveCount(0)
  } finally { await context.close() }
})

test("Given a delegated owner device, when it grants an editor access twice, then the editor verifies both grants", async ({ page, browser }) => {
  test.setTimeout(180_000)
  const ownerContext = await browser.newContext()
  const editorContext = await browser.newContext()
  const owner2 = await ownerContext.newPage()
  const editor = await editorContext.newPage()
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const owner1Dialog = page.getByRole("dialog", { name: "Device sync" })
    await owner1Dialog.getByRole("button", { name: "Add someone" }).click()
    await owner1Dialog.getByRole("button", { name: "Add my device", exact: true }).click()
    await owner2.goto(await owner1Dialog.getByLabel("Pairing link").inputValue())
    const owner2Dialog = owner2.getByRole("dialog", { name: "Device sync" })
    await owner2Dialog.getByRole("button", { name: "Add this device" }).waitFor({ state: "visible" })
    if (await owner2Dialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).count()) await owner2Dialog.getByRole("checkbox", { name: /Replace this device.s identity/ }).check()
    await owner2Dialog.getByRole("button", { name: "Add this device" }).click()
    await owner1Dialog.getByRole("button", { name: "Approve device" }).click()
    await expect(owner2Dialog.getByText("Device enrolled", { exact: true })).toBeVisible()
    await owner2Dialog.getByRole("button", { name: "Close", exact: true }).first().click()

    const inviteEditor = async () => {
      await expect(owner2.getByLabel("Workspace role: owner")).toBeVisible({ timeout: 15_000 })
      await owner2.getByRole("button", { name: "Sync", exact: true }).click()
      try {
        await expect(owner2Dialog.getByRole("button", { name: "Add someone" })).toBeVisible({ timeout: 15_000 })
      } catch (error) {
        console.error("Delegated owner sync dialog:", await owner2Dialog.ariaSnapshot())
        console.error("Delegated owner role:", await owner2.locator('[aria-label^="Workspace role:"]').getAttribute("aria-label"))
        throw error
      }
      await owner2Dialog.getByRole("button", { name: "Add someone" }).click()
      await owner2Dialog.getByRole("button", { name: "Generate link" }).click()
      await editor.goto(await owner2Dialog.getByLabel("Pairing link").inputValue())
      const editorDialog = editor.getByRole("dialog", { name: "Device sync" })
      const joinAction = editorDialog.getByRole("button", { name: /^(Merge and join|Accept and join)$/ })
      await expect(joinAction).toBeVisible()
      await joinAction.click()
      await owner2Dialog.getByLabel("Participant role").selectOption("editor")
      await owner2Dialog.getByRole("button", { name: "Approve access" }).click()
      await expect(editorDialog.getByText(/Connected to/)).toBeVisible({ timeout: 30_000 })
      await editorDialog.getByRole("button", { name: "Close", exact: true }).first().click()
      await owner2Dialog.getByRole("button", { name: "Close", exact: true }).first().click()
    }

    await inviteEditor()
    await editor.getByRole("button", { name: /Add lead to/ }).first().click()
    await editor.getByLabel("Company *").fill("Offline editor history")
    await editor.getByLabel("Role *").fill("Engineer")
    await editor.getByRole("button", { name: "Create item" }).click()
    await editor.getByRole("button", { name: "Close detail" }).click()
    await editor.getByRole("button", { name: "Sync", exact: true }).click()
    const editorDialog = editor.getByRole("dialog", { name: "Device sync" })
    await editorDialog.getByText("Recovery", { exact: true }).click()
    await editorDialog.getByRole("button", { name: "Leave mesh" }).click()
    await editorDialog.getByRole("button", { name: "Leave mesh, keep copy" }).click()
    const closeEditorSync = editorDialog.getByRole("button", { name: "Close", exact: true }).first()
    await expect.poll(async () => await closeEditorSync.isDisabled() ||
      await editor.getByLabel("Workspace role: visitor").isVisible()).toBe(true)
    await expect(editor.getByLabel("Workspace role: visitor")).toBeVisible({ timeout: 30_000 })
    await expect(editor.getByLabel("Mesh connected")).toHaveCount(0)
    await expect(closeEditorSync).toBeEnabled()
    await closeEditorSync.click()
    await expect(owner2.getByRole("button", { name: "Open Offline editor history — Engineer" })).toBeVisible({ timeout: 30_000 })
    await inviteEditor()
    await expect(editor.getByLabel("Workspace role: editor")).toBeVisible()
    // This scenario owns its Playwright project. Worker teardown closes both
    // contexts; manual close can block indefinitely inside Chromium WebRTC.
})
