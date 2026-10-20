import { expect, test } from "./support/coverage"

test("Given board settings, When opened and dismissed with Escape, Then settings use the shared movable window and focus returns to its trigger", async ({ page }, info) => {
  await page.goto("/")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  const trigger = page.getByRole("button", { name: "Settings", exact: true })
  await trigger.click()

  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(settings).toBeVisible()
  await expect(settings).toHaveClass(/spatial-window/)
  await expect(settings.locator(".spatial-titlebar")).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Identity", exact: true })).toBeVisible()
  await expect(page.locator(".overlay")).toHaveCount(0)
  await page.screenshot({ path: info.outputPath("settings-window.png") })

  await page.keyboard.press("Escape")
  await expect(settings).toBeHidden()
  await expect(trigger).toBeFocused()
})

test("Given workspace management, When backup import fails, Then the error and retry action remain inside its shared window", async ({ page }, info) => {
  await page.goto("/")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
  const workspaces = page.getByRole("dialog", { name: "Workspaces", exact: true })
  await expect(workspaces).toHaveClass(/spatial-window/)

  const chooser = page.waitForEvent("filechooser")
  await workspaces.getByRole("button", { name: "Import as new board", exact: true }).click()
  await (await chooser).setFiles({ name: "invalid.tincanban", mimeType: "application/vnd.tincanban+zip", buffer: Buffer.from("not a backup") })
  await expect(workspaces.getByRole("alert")).toBeVisible()
  await expect(workspaces.getByRole("button", { name: "Import as new board", exact: true })).toBeEnabled()
  await page.screenshot({ path: info.outputPath("workspace-import-error-window.png") })
})

test("Given workspace settings, When backup controls open, Then content remains in the shared window", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const sync = page.getByRole("dialog", { name: "Settings", exact: true })
  await expect(sync).toHaveClass(/spatial-window/)
  await sync.getByRole("tab", { name: "Workspace", exact: true }).click()
  await expect(sync.getByRole("tabpanel", { name: "Workspace", exact: true }).getByRole("button", { name: "Export .tincanban", exact: true })).toBeVisible()
  await expect(page.locator(".overlay")).toHaveCount(0)
})

test("Given workspace creation is pending, When the user tries to reach the board, Then the board stays inert until success or failure", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto("/")
  await expect(page.getByLabel("Workspace role: owner")).toBeVisible()
  await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
  await page.getByRole("button", { name: "New workspace", exact: true }).click()
  const create = page.getByRole("dialog", { name: "Create workspace", exact: true })
  await create.getByLabel("Title", { exact: true }).fill("Delayed workspace")

  await page.evaluate(async () => {
    type Gate = { started: boolean; succeed: () => void; fail: () => void }
    type GateWindow = Window & { __TINCANBAN_WORKSPACE_CREATE_GATE__?: Gate }
    const { defaultStorage } = await import("/src/storage.ts")
    const prototype = Object.getPrototypeOf(defaultStorage) as { commitWorkspaceAtRevision: (...args: any[]) => Promise<unknown> }
    const original = prototype.commitWorkspaceAtRevision
    prototype.commitWorkspaceAtRevision = function (this: typeof defaultStorage, ...args: any[]) {
      return new Promise((resolve, reject) => {
      const current = window as GateWindow
      current.__TINCANBAN_WORKSPACE_CREATE_GATE__ = {
        started: true,
        succeed: () => {
          prototype.commitWorkspaceAtRevision = original
          void original.apply(defaultStorage, args).then(resolve, reject)
        },
        fail: () => {
          prototype.commitWorkspaceAtRevision = original
          reject(new Error("Workspace creation failed"))
        },
      }
      })
    }
  })

  await create.getByRole("button", { name: "Create", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as Window & { __TINCANBAN_WORKSPACE_CREATE_GATE__?: { started: boolean } }).__TINCANBAN_WORKSPACE_CREATE_GATE__?.started)).toBe(true)
  await expect(page.locator(".shell")).toHaveAttribute("inert", "")
  await expect(create.getByRole("button", { name: "Creating…", exact: true })).toBeDisabled()
  await expect(page.getByRole("dialog", { name: "Item details", exact: true })).toHaveCount(0)

  await page.evaluate(() => (window as Window & { __TINCANBAN_WORKSPACE_CREATE_GATE__?: { fail: () => void } }).__TINCANBAN_WORKSPACE_CREATE_GATE__?.fail())
  await expect(create.getByRole("alert")).toHaveText("Workspace creation failed")
  await expect(create.getByLabel("Title", { exact: true })).toHaveValue("Delayed workspace")
  await expect(page.locator(".shell")).not.toHaveAttribute("inert", "")

  await page.evaluate(async () => {
    type Gate = { started: boolean; succeed: () => void }
    type GateWindow = Window & { __TINCANBAN_WORKSPACE_CREATE_GATE__?: Gate }
    const { defaultStorage } = await import("/src/storage.ts")
    const prototype = Object.getPrototypeOf(defaultStorage) as { commitWorkspaceAtRevision: (...args: any[]) => Promise<unknown> }
    const original = prototype.commitWorkspaceAtRevision
    prototype.commitWorkspaceAtRevision = function (this: typeof defaultStorage, ...args: any[]) {
      return new Promise((resolve, reject) => {
        ;(window as GateWindow).__TINCANBAN_WORKSPACE_CREATE_GATE__ = {
          started: true,
          succeed: () => {
            prototype.commitWorkspaceAtRevision = original
            void original.apply(defaultStorage, args).then(resolve, reject)
          },
        }
      })
    }
  })
  await create.getByRole("button", { name: "Create", exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as Window & { __TINCANBAN_WORKSPACE_CREATE_GATE__?: { started: boolean } }).__TINCANBAN_WORKSPACE_CREATE_GATE__?.started)).toBe(true)
  await expect(page.locator(".shell")).toHaveAttribute("inert", "")
  await page.evaluate(() => (window as Window & { __TINCANBAN_WORKSPACE_CREATE_GATE__?: { succeed: () => void } }).__TINCANBAN_WORKSPACE_CREATE_GATE__?.succeed())
  await expect(create).toBeHidden()
  await expect(page.getByRole("heading", { name: "TINCANBAN // Delayed workspace" })).toBeVisible()
  await expect(page.locator(".shell")).not.toHaveAttribute("inert", "")
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Item details", exact: true })).toBeVisible()
})
