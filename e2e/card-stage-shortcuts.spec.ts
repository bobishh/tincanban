import { expect, test } from "./support/coverage"

async function createBoard(page: import("@playwright/test").Page) {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const dialog = page.getByRole("dialog", { name: "Create workspace" })
  await dialog.getByLabel("Title").fill("Reading List")
  await dialog.getByRole("radio", { name: "Blank board" }).check()
  await dialog.getByRole("button", { name: "Create" }).click()
  await page.getByRole("button", { name: "Add item to To do" }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Read Dune")
  await form.getByRole("button", { name: "Save item" }).click()
  await page.getByRole("button", { name: "Open Read Dune" }).click()
  return page.getByRole("dialog", { name: "Item overview" })
}

async function holdWorkspaceWrites(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
    await new Promise<void>(acquired => {
      void navigator.locks.request(`tincanban-workspace-command:${app.activeWorkspace.id}`, () => {
        acquired()
        return new Promise<void>(release => { Object.assign(window, { releaseStageWrite: release }) })
      })
    })
  })
}

async function releaseWorkspaceWrites(page: import("@playwright/test").Page) {
  await page.evaluate(() => (window as unknown as { releaseStageWrite(): void }).releaseStageWrite())
}

test("Given delayed local persistence, when stages change twice, then selection and board move immediately and the final stage survives reload", async ({ page }) => {
  const detail = await createBoard(page)
  await holdWorkspaceWrites(page)
  try {
    for (const stage of ["Doing", "Done"]) {
      const result = await detail.getByRole("button", { name: stage, exact: true }).evaluate(async button => {
        const started = performance.now()
        ;(button as HTMLButtonElement).click()
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        return { elapsed: performance.now() - started, selected: button.getAttribute("aria-pressed"), disabled: (button as HTMLButtonElement).disabled }
      })
      expect(result.selected).toBe("true")
      expect(result.disabled).toBe(false)
      expect(result.elapsed).toBeLessThan(200)
      await expect(page.getByRole("region", { name: stage, exact: true }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
    }
    await expect(detail.getByRole("status")).toContainText("Saving")
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true)
  } finally { await releaseWorkspaceWrites(page) }
  await expect(detail.getByRole("status")).toHaveCount(0)
  expect(await page.evaluate(() => window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(true)
  await page.reload()
  await expect(page.getByRole("region", { name: "Done", exact: true }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
})

test("Given delayed failing local persistence, when stage changes, then selection previews immediately and failure restores selection and board placement", async ({ page }) => {
  const detail = await createBoard(page)
  await holdWorkspaceWrites(page)
  await page.evaluate(() => { Object.assign(window, { __TINCANBAN_INJECT_STORAGE_FAILURE__: true }) })
  try {
    await detail.getByRole("button", { name: "Doing", exact: true }).click()
    await expect(detail.getByRole("button", { name: "Doing", exact: true })).toHaveAttribute("aria-pressed", "true")
    await expect(page.getByRole("region", { name: "Doing", exact: true }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
  } finally { await releaseWorkspaceWrites(page) }
  await expect(detail.getByRole("alert")).toContainText("Storage failure injected")
  await expect(detail.getByRole("button", { name: "To do", exact: true })).toHaveAttribute("aria-pressed", "true")
  await expect(page.getByRole("region", { name: "To do", exact: true }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
  await page.evaluate(() => { Object.assign(window, { __TINCANBAN_INJECT_STORAGE_FAILURE__: false }) })
  await detail.getByRole("button", { name: "Doing", exact: true }).click()
  await expect(detail.getByRole("status")).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole("region", { name: "Doing", exact: true }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
})

test("Given a generic card, when stage shortcut is clicked, then card moves and selection persists", async ({ page }) => {
  const detail = await createBoard(page)
  await expect(detail.getByRole("button", { name: "To do" })).toHaveClass(/active/)
  await detail.getByRole("button", { name: "Doing" }).click()
  await expect(detail.getByRole("button", { name: "Doing" })).toHaveClass(/active/)
  await expect(detail.getByRole("status")).toHaveCount(0)
  await detail.getByRole("button", { name: "Close detail" }).click()
  await expect(page.getByRole("region", { name: "Doing" }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByRole("region", { name: "Doing" }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
})

test("Given a generic card, when stage move fails, then card stays put and error appears", async ({ page }) => {
  const detail = await createBoard(page)
  await page.evaluate(() => { (window as Window & { __TINCANBAN_INJECT_STORAGE_FAILURE__?: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
  await detail.getByRole("button", { name: "Doing" }).click()
  await expect(detail.getByRole("alert")).toContainText("Storage failure injected")
  await expect(detail.getByRole("button", { name: "To do" })).toHaveClass(/active/)
  await detail.getByRole("button", { name: "Close detail" }).click()
  await expect(page.getByRole("region", { name: "To do" }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
})

test("Given board JSON, when stage buttons are configured, then card shows configured buttons and order", async ({ page }) => {
  await createBoard(page)
  await page.getByRole("dialog", { name: "Item overview" }).getByRole("button", { name: "Close detail" }).click()
  await page.getByRole("button", { name: "Settings" }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
  await settings.getByText("settings.json", { exact: true }).click()
  const editor = settings.getByLabel("Workspace settings JSON")
  const config = JSON.parse(await editor.inputValue())
  expect(config.board.cardStageButtons).toHaveLength(3)
  config.board.cardStageButtons = [
    { columnId: config.board.columns[2].id, label: "Finished" },
    { columnId: config.board.columns[0].id },
  ]
  await editor.fill(JSON.stringify(config, null, 2))
  await settings.getByRole("button", { name: "Apply JSON" }).click()
  await page.getByRole("button", { name: "Open Read Dune" }).click()
  const detail = page.getByRole("dialog", { name: "Item overview" })
  await expect(detail.locator(".status-strip button")).toHaveText(["Finished", "To do"])
  await expect(detail.getByRole("button", { name: "Doing" })).toHaveCount(0)
  await detail.getByRole("button", { name: "Finished" }).click()
  await expect(detail.getByRole("button", { name: "Finished" })).toHaveClass(/active/)
  await expect(detail.getByRole("status")).toHaveCount(0)
  await detail.getByRole("button", { name: "Close detail" }).click()
  await page.reload()
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByRole("region", { name: "Done" }).getByRole("button", { name: "Open Read Dune" })).toBeVisible()
  await page.getByRole("button", { name: "Open Read Dune" }).click()
  await expect(page.getByRole("dialog", { name: "Item overview" }).locator(".status-strip button")).toHaveText(["Finished", "To do"])
})
