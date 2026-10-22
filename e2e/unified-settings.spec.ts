import { expect, test, type Page, type Locator } from "./support/coverage"

test("Given a healthy board, when Workspace settings opens, then it shows saved status without an empty sync warning", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
  await expect(settings.getByRole("region", { name: "Workspace status" })).toContainText("Changes saved on this device.")
  await expect(settings.getByRole("region", { name: "Workspace status" }).locator(".sync-error")).toHaveCount(0)
  await expect(settings.getByText("Sync problem details", { exact: true })).toHaveCount(0)
})

test("Given a sync failure while local data stays saved, when Workspace settings opens, then the reason is visible and disappears after recovery", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
  const setDiagnostic = (message: string) => page.evaluate(value => {
    // Exercise the mounted app's actual reactive controller in this isolated tab.
    const root = document.querySelector("#app") as Element & {
      __vue_app__: { _instance: { setupState: { sync: { meshDiagnostic: { value: string } } } } }
    }
    root.__vue_app__._instance.setupState.sync.meshDiagnostic.value = value
  }, message)
  await setDiagnostic("Direct session ended: remote device disconnected.")
  const warning = settings.getByRole("region", { name: "Workspace status" }).locator(".sync-error")
  await expect(warning).toContainText("Direct session ended: remote device disconnected.")
  await expect(warning).toContainText("Open Sync to check the connection.")
  await expect(settings.getByRole("region", { name: "Workspace status" })).toContainText("Changes saved on this device.")
  await setDiagnostic("")
  await expect(warning).toHaveCount(0)
})

async function participantsFromSettings(page: Page, settings: Locator) {
  await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  return page.getByRole("dialog", { name: "Device sync" })
}

test("Given Settings is open, when Identity settings opens, then identity-only backup and restore stay unavailable", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Identity", exact: true }).click()
  await expect(settings.getByRole("region", { name: "Identity recovery" })).toHaveCount(0)
  await expect(settings.getByRole("button", { name: "Recovery backup", exact: true })).toHaveCount(0)
  await expect(settings.getByRole("region", { name: "Private workspace recovery" })).toBeVisible()
})

test("Settings keeps identity available while workspace controls stay role-gated", async ({ page }) => {
  await page.goto("/")
  const actions = page.locator(".top-actions-desktop")

  await expect(actions.getByRole("button", { name: "Settings" })).toHaveCount(1)
  await expect(actions.getByRole("button", { name: "Workspace settings" })).toHaveCount(0)
  await actions.getByRole("button", { name: "Settings" }).click()

  const settings = page.getByRole("dialog", { name: "Settings" })
  await expect(settings.getByRole("tab", { name: "Identity" })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Your profile" })).toHaveCount(0)
  await expect(settings.getByRole("tab", { name: "Workspace" })).toBeVisible()
  await expect(settings.getByRole("tab", { name: "Workspace", exact: true })).toBeVisible()
  await settings.getByRole("tab", { name: "Identity" }).click()
  await expect(settings.getByLabel("Name")).toHaveValue("")
  await expect(settings.getByRole("button", { name: "Save profile" })).toBeDisabled()
  await settings.getByLabel("Name").fill("Settings identity")
  await settings.getByRole("button", { name: "Save profile" }).click()
  await expect(settings.getByLabel("Name")).toHaveValue("Settings identity")
  const nameWidth = await settings.getByLabel("Name").evaluate(element => element.getBoundingClientRect().width)
  const buttonWidth = await settings.getByRole("button", { name: "Save profile" }).evaluate(element => element.getBoundingClientRect().width)
  expect(buttonWidth).toBeLessThan(nameWidth)
  const participants = await participantsFromSettings(page, settings)
  await expect(participants.locator(".mesh-member").filter({ hasText: "You" })).toContainText("Settings identity")
  await expect(participants.locator(".mesh-member").filter({ hasText: "You" })).not.toContainText("Chat name:")
  await participants.getByRole("button", { name: "Close", exact: true }).click()

  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title").fill("Second board")
  await create.getByRole("button", { name: "Create" }).click()
  await expect(page.getByRole("region", { name: "Second board" })).toBeVisible()

  await actions.getByRole("button", { name: "Settings" }).click()
  const secondSettings = page.getByRole("dialog", { name: "Settings" })
  await secondSettings.getByRole("tab", { name: "Identity" }).click()
  await expect(secondSettings.getByLabel("Name")).toHaveValue("Settings identity")
})

test("Given two workspaces, when identity name changes, then both show that name even with older chat announcements", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Workspace chat" }).click()
  const originalChat = page.getByRole("dialog", { name: "Workspace chat" })
  await originalChat.getByRole("textbox", { name: "Message" }).fill("Name before rename")
  await originalChat.getByRole("button", { name: "Send message" }).click()
  await expect(originalChat.getByText("Name before rename")).toBeVisible()
  await originalChat.getByRole("button", { name: "Close" }).click()

  await page.getByRole("button", { name: "Open workspaces" }).click()
  const originalWorkspace = await page.locator(".workspace-switch strong").first().innerText()
  await page.getByRole("button", { name: "New workspace" }).click()
  await page.getByRole("dialog", { name: "Create workspace" }).getByLabel("Title").fill("Other board")
  await page.getByRole("button", { name: "Create", exact: true }).click()
  await expect(page.getByRole("region", { name: "Other board" })).toBeVisible()

  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  await settings.getByRole("tab", { name: "Identity" }).click()
  await settings.getByLabel("Name").fill("Bo")
  await settings.getByRole("button", { name: "Save profile" }).click()
  const participants = await participantsFromSettings(page, settings)
  await expect(participants.locator(".mesh-member").filter({ hasText: "You" })).toContainText("Bo")
  await participants.getByRole("button", { name: "Close", exact: true }).click()

  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.locator(".workspace-switch").filter({ hasText: originalWorkspace }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const originalSettings = page.getByRole("dialog", { name: "Settings", exact: true })
  const originalParticipants = await participantsFromSettings(page, originalSettings)
  const self = originalParticipants.locator(".mesh-member").filter({ hasText: "You" })
  await expect(self).toContainText("Bo")
  await expect(self).not.toContainText("Chat name:")
  await originalParticipants.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Workspace chat" }).click()
  const renamedMessage = page.getByRole("article").filter({ hasText: "Name before rename" })
  await expect(renamedMessage.locator(".chat-message-author")).toHaveText("Bo")
})
