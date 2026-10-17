import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given newer local databases, when tincanban saves workspace and chat data, then it opens without downgrade errors", async ({ page }) => {
  await page.route("**/db-bootstrap", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>bootstrap</title>" }))
  await page.goto("/db-bootstrap")
  await page.evaluate(async () => {
    const createVersionTwo = (name: string, upgrade: (database: IDBDatabase) => void) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 2)
      request.onupgradeneeded = () => upgrade(request.result)
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(request.error)
    })
    await createVersionTwo("match", database => database.createObjectStore("workspace"))
    await createVersionTwo("tincanban-write-authorizations-v1", database => database.createObjectStore("records"))
    await createVersionTwo("tincanban-chat-v1", database => {
      const messages = database.createObjectStore("messages", { keyPath: ["workspaceId", "id"] })
      messages.createIndex("by_workspace_order", ["workspaceId", "orderKey"], { unique: false })
      messages.createIndex("by_workspace", "workspaceId", { unique: false })
      const profiles = database.createObjectStore("profiles", { keyPath: ["workspaceId", "personId"] })
      profiles.createIndex("by_workspace", "workspaceId", { unique: false })
      database.createObjectStore("meta", { keyPath: "workspaceId" })
    })
  })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(error.message))
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })

  await page.goto("/")

  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeVisible()
  await createJobSearchWorkspace(page, "Version two")
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 3_000 })
  const form = page.getByRole("dialog", { name: /Add item|Item details/ })
  await form.getByLabel("Company *").fill("Schema-safe")
  await form.getByLabel("Role *").fill("Engineer")
  await form.getByRole("button", { name: "Create item" }).click()
  await expect(page.getByRole("dialog", { name: "Item overview" })).toContainText("Schema-safe")
  await page.getByRole("button", { name: "Close detail" }).click()
  await page.getByRole("button", { name: "Workspace chat", exact: true }).filter({ visible: true }).click()
  const chat = page.getByRole("dialog", { name: "Workspace chat", exact: true })
  await chat.getByRole("textbox", { name: "Message", exact: true }).fill("Version-safe chat")
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.getByText("Version-safe chat", { exact: true })).toBeVisible()
  expect(errors.filter(message => message.includes("requested version (1) is less than the existing version (2)"))).toEqual([])
})

test("Given storage failure, when an item is saved, then failure stays visible and no card publishes", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title").fill("Failure board")

  await create.getByRole("button", { name: "Create" }).click()
  await page.getByRole("button", { name: /Add item to/ }).first().click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Unsaved item")
  await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })

  await form.getByRole("button", { name: "Save item" }).click()

  await expect(form.getByRole("alert")).toContainText(/Storage failure|Save failed/i)
  await expect(page.locator(".save-state")).toHaveText("Not saved")
  await expect(page.getByRole("button", { name: "Open Unsaved item" })).toHaveCount(0)
})
