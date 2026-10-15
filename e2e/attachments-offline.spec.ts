import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given file controls and streaming storage were preloaded online, when the device goes offline, then attach and preview a new multi-chunk file locally", async ({ page, context, baseURL }) => {
  const storageReady = page.waitForResponse(response => /mesh-blob.*streamStore/.test(response.url()) && response.ok())
  await page.goto(baseURL!)
  await ensureJobSearchWorkspace(page)
  await storageReady
  await page.evaluate(() => {
    File.prototype.arrayBuffer = async () => { throw new Error("Whole-file read is forbidden") }
  })
  await context.setOffline(true)
  try {
    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    const form = page.getByRole("dialog", { name: "Add item" })
    await form.getByLabel("Company *").fill("Offline attachment")
    await form.getByLabel("Role *").fill("Local file")
    await form.getByRole("button", { name: "Create item", exact: true }).click()
    await page.getByRole("button", { name: "Open Offline attachment — Local file", exact: true }).click()
    const detail = page.getByRole("dialog", { name: "Item overview" })
    await detail.getByRole("button", { name: "+ File", exact: true }).click()
    const attach = detail.getByRole("form", { name: "Attach document" })
    await attach.getByLabel("Title").fill("Offline file")
    const prefix = "Saved entirely on this device.\n"
    await attach.getByLabel("File").setInputFiles({ name: "offline.txt", mimeType: "text/plain",
      buffer: Buffer.concat([Buffer.from(prefix), Buffer.alloc(256 * 1024 + 19, 0x5a)]) })
    await attach.getByRole("button", { name: "Attach", exact: true }).click()
    await detail.getByRole("group", { name: "Offline file", exact: true }).getByRole("button", { name: "Preview", exact: true }).click()
    await expect(page.getByRole("dialog", { name: "Document preview" })).toContainText(prefix.trim())
  } finally {
    await context.setOffline(false)
  }
})
