import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

test("Given file controls and streaming storage were preloaded online, when the device goes offline, then attach and preview a new multi-chunk file locally", async ({ page, context, baseURL }) => {
  const storageReady = page.waitForResponse(response => /mesh-blob.*streamStore/.test(response.url()) && response.ok())
  await page.goto(baseURL!)
  await ensureJobSearchWorkspace(page)
  await storageReady
  await page.evaluate(async () => {
    const [signing, spatial, detail, itemDetail, itemForm, documents, blobStore, fileStream] = await Promise.all([
      import("/src/sync/localCommandSigning.ts"),
      import("/src/components/SpatialWindow.vue"),
      import("/src/components/ItemDetailDialog.vue"),
      import("/src/components/ItemDetailDialog.vue"),
      import("/src/components/ItemFormDialog.vue"),
      import("/src/components/ItemDocuments.vue"),
      import("/src/attachmentBlobStore.ts"),
      import("/src/attachmentFileStream.ts"),
    ])
    void [signing, spatial, detail, itemDetail, itemForm, documents, blobStore]
    await fileStream.preloadBlobStreamStorage()
  })
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
    await expect(page.getByText("Document attached", { exact: true })).toBeVisible()
    const openPreview = detail.getByRole("group", { name: "Offline file", exact: true }).getByRole("button", { name: "Preview", exact: true })
    await openPreview.click()
    const preview = page.getByRole("dialog", { name: "Document preview" })
    await expect(preview).toContainText(prefix.trim(), { timeout: 15_000 })
    await expect(preview).toContainText("Showing the beginning of this file")
    expect(await preview.locator(".document-preview-text").textContent()).toHaveLength(32 * 1024)
    await expect(preview.getByRole("status")).toHaveCount(0)
    await preview.getByRole("button", { name: "Close", exact: true }).click()

    // Hold the next local read so pending-state coverage does not depend on disk speed.
    await page.evaluate(async () => {
      const { attachmentBlobStore } = await import("/src/attachmentBlobStore.ts")
      const read = attachmentBlobStore.getVerified.bind(attachmentBlobStore)
      attachmentBlobStore.getVerified = async (...args) => {
        attachmentBlobStore.getVerified = read
        await new Promise<void>(resolve => window.addEventListener("test:release-attachment-read", () => resolve(), { once: true }))
        return read(...args)
      }
    })
    await openPreview.click()
    await expect(preview.getByRole("status")).toHaveText("Loading preview…")
    await expect(preview.locator(".document-preview-text")).toHaveCount(0)
    await page.evaluate(() => window.dispatchEvent(new Event("test:release-attachment-read")))
    await expect(preview).toContainText(prefix.trim())
    await expect(preview.getByRole("status")).toHaveCount(0)
  } finally {
    await context.setOffline(false)
  }
})
