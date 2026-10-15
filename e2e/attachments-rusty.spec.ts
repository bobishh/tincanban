import { readFile } from "node:fs/promises"
import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"
import { startRustyService } from "./support/rustyService"

/**
 * Complete coverage requires verified receipts for the manifest and every chunk.
 * The source may close before the recipient requests its first attachment byte.
 */
test("Given confirmed Rusty attachment coverage, when the source browser closes, then a fresh same-person device previews and downloads verified bytes", async ({ browser, baseURL }) => {
  test.setTimeout(120_000)
  const sourceContext = await browser.newContext()
  const recipientContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
  })
  const source = await sourceContext.newPage()
  const recipient = await recipientContext.newPage()
  let sourceClosed = false
  let rusty: Awaited<ReturnType<typeof startRustyService>> | undefined
  try {
    await source.goto(baseURL!)
    await ensureJobSearchWorkspace(source)
    const trustedOwner = await source.evaluate(async () => {
      const { bootstrapIdentity } = await import("/src/domain/identity.ts")
      const profile = await bootstrapIdentity()
      return { identity: profile.identity, allowedControllerDeviceIds: [profile.device.deviceId] }
    })
    const service = await startRustyService(trustedOwner, baseURL!)
    rusty = service

    await source.getByRole("button", { name: "Sync", exact: true }).click()
    const ownerSync = source.getByRole("dialog", { name: "Device sync" })
    await ownerSync.getByRole("button", { name: "Add someone", exact: true }).click()
    await ownerSync.getByRole("button", { name: "Add my device", exact: true }).click()
    await recipient.goto(await ownerSync.getByLabel("Pairing link").inputValue())
    const enrollment = recipient.getByRole("dialog", { name: "Device sync" })
    const replace = enrollment.getByRole("checkbox", { name: /Replace this device.s identity/ })
    await expect(enrollment.getByRole("button", { name: "Add this device", exact: true })).toBeVisible()
    if (await replace.count()) await replace.check()
    await enrollment.getByRole("button", { name: "Add this device", exact: true }).click()
    await expect(ownerSync.getByRole("button", { name: "Approve device", exact: true })).toBeVisible({ timeout: 30_000 })
    await ownerSync.getByRole("button", { name: "Approve device", exact: true }).click()
    await expect(enrollment.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30_000 })
    await enrollment.getByRole("button", { name: "Close", exact: true }).click()
    await ownerSync.getByRole("button", { name: "Close", exact: true }).click()

    await source.getByRole("button", { name: /Add lead to/ }).first().click()
    const addLead = source.getByRole("dialog", { name: "Add item" })
    await addLead.getByLabel("Company *").fill("Northstar Attachment Test")
    await addLead.getByLabel("Role *").fill("Encrypted file recipient")
    await addLead.getByRole("button", { name: "Create item", exact: true }).click()
    await source.getByRole("button", { name: "Open Northstar Attachment Test — Encrypted file recipient", exact: true }).click()

    const previewText = "Encrypted attachment survives source shutdown.\n"
    const payload = Buffer.concat([Buffer.from(previewText), Buffer.alloc(384 * 1024 + 19, 0x5a)])
    const detail = source.getByRole("dialog", { name: "Lead details" })
    await detail.getByRole("button", { name: "+ File", exact: true }).click()
    const fileForm = detail.getByRole("form", { name: "Attach document" })
    await fileForm.getByLabel("Title").fill("Private transfer fixture")
    await fileForm.getByLabel("File").setInputFiles({
      name: "private-transfer-fixture.txt",
      mimeType: "text/plain",
      buffer: payload,
    })
    await fileForm.getByRole("button", { name: "Attach", exact: true }).click()
    await detail.getByRole("button", { name: "Close detail", exact: true }).click()
    await source.getByRole("button", { name: "Sync", exact: true }).click()
    await source.getByRole("tab", { name: "Rusty", exact: true }).click()
    const rustyPanel = source.getByRole("region", { name: "Rusty", exact: true })
    await rustyPanel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await rustyPanel.getByLabel("Address", { exact: true }).fill(service.origin)
    await rustyPanel.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(rustyPanel.locator(":scope > .rusty-connections").getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    await source.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    await source.getByRole("button", { name: "Open Northstar Attachment Test — Encrypted file recipient", exact: true }).click()
    const sourceDetail = source.getByRole("dialog", { name: "Lead details" })
    const attachment = sourceDetail.getByRole("group", { name: "Private transfer fixture" })
    await expect(attachment.getByRole("status", { name: "Encrypted attachment coverage" }))
      .toHaveText("Complete on Rusty", { timeout: 30_000 })

    await recipient.getByRole("button", { name: "Menu", exact: true }).click()
    await recipient.getByRole("button", { name: "Sync & backups", exact: true }).click()
    await recipient.getByRole("tab", { name: "Rusty", exact: true }).click()
    const recipientRusty = recipient.getByRole("region", { name: "Rusty", exact: true })
    await expect(recipientRusty.locator(":scope > .rusty-connections").getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    await recipient.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    await expect(recipient.getByRole("button", { name: "Open Northstar Attachment Test — Encrypted file recipient", exact: true }))
      .toBeVisible({ timeout: 30_000 })
    await recipient.getByRole("button", { name: "Open Northstar Attachment Test — Encrypted file recipient", exact: true }).click()
    const recipientDetail = recipient.getByRole("dialog", { name: "Lead details" })
    const recipientAttachment = recipientDetail.getByRole("group", { name: "Private transfer fixture" })
    await expect(recipientAttachment.getByRole("status", { name: "Encrypted attachment coverage" }))
      .toHaveText("Complete on Rusty")
    const localBytesBeforeClose = await recipient.evaluate(async () => {
      const { useTincanban } = await import("/src/state.ts")
      const { blobDescriptor, readStoredAttachment } = await import("/src/attachments.ts")
      const doc = useTincanban().getActiveDoc()!
      const attachment = Object.values(doc.entities).find(entity => entity.kind === "document" && entity.title === "Private transfer fixture")
      if (!attachment || attachment.kind !== "document" || !attachment.file || attachment.file.type !== "blob") throw new Error("Replicated blob attachment reference is missing")
      const descriptor = blobDescriptor(attachment.file)
      if (!descriptor) throw new Error("Replicated attachment has no usable blob descriptor")
      return readStoredAttachment(descriptor)
    })
    expect(localBytesBeforeClose).toBeUndefined()

    // Opening item details only reads reference metadata; preview is the first byte request.
    await recipientDetail.getByRole("button", { name: "Close detail", exact: true }).click()
    await sourceContext.close()
    sourceClosed = true
    await recipient.getByRole("button", { name: "Open Northstar Attachment Test — Encrypted file recipient", exact: true }).click()
    const remoteDetail = recipient.getByRole("dialog", { name: "Lead details" })
    const remoteAttachment = remoteDetail.getByRole("group", { name: "Private transfer fixture" })
    await remoteAttachment.getByRole("button", { name: "Preview", exact: true }).click()
    await expect(recipient.getByRole("dialog", { name: "Document preview" })).toContainText(previewText.trim(), { timeout: 30_000 })
    await expect(recipient.getByRole("dialog", { name: "Document preview" })).toContainText("Showing the beginning of this file")
    expect(await recipient.locator(".document-preview-text").textContent()).toHaveLength(32 * 1024)
    await recipient.getByRole("dialog", { name: "Document preview" }).getByRole("button", { name: "Close", exact: true }).click()

    const downloadStarted = recipient.waitForEvent("download")
    await remoteAttachment.getByRole("button", { name: "Download", exact: true }).click()
    const download = await downloadStarted
    expect(download.suggestedFilename()).toBe("private-transfer-fixture.txt")
    const downloadedPath = await download.path()
    expect(downloadedPath).toBeTruthy()
    expect(await readFile(downloadedPath!)).toEqual(payload)
  } finally {
    if (!sourceClosed) await sourceContext.close()
    await recipientContext.close()
    await rusty?.close()
  }
})

test("Given file uploads are unavailable, when a card is edited, then its metadata still replicates and the file never claims complete coverage", async ({ page, baseURL }) => {
  test.setTimeout(90_000)
  await page.goto(baseURL!)
  await ensureJobSearchWorkspace(page)
  const owner = await page.evaluate(async () => {
    const { bootstrapIdentity } = await import("/src/domain/identity.ts")
    const profile = await bootstrapIdentity()
    return { identity: profile.identity, allowedControllerDeviceIds: [profile.device.deviceId] }
  })
  const rusty = await startRustyService(owner, baseURL!)
  try {
    await page.route("**/v2/scopes/*/blobs/*", async route => {
      if (route.request().method() === "PUT") await route.fulfill({ status: 503, contentType: "application/json",
        body: JSON.stringify({ message: "Attachment storage temporarily unavailable" }) })
      else await route.continue()
    })
    let metadataUploads = 0
    page.on("response", response => {
      if (response.ok() && response.request().method() === "PUT" && /\/objects\//.test(response.url())) metadataUploads++
    })
    await page.getByRole("button", { name: /Add lead to/ }).first().click()
    const create = page.getByRole("dialog", { name: "Add item" })
    await create.getByLabel("Company *").fill("File failure fixture")
    await create.getByLabel("Role *").fill("Independent card save")
    await create.getByRole("button", { name: "Create item", exact: true }).click()
    const open = page.getByRole("button", { name: "Open File failure fixture — Independent card save", exact: true })
    await open.click()
    const detail = page.getByRole("dialog", { name: "Lead details" })
    await detail.getByRole("button", { name: "+ File", exact: true }).click()
    const form = detail.getByRole("form", { name: "Attach document" })
    await form.getByLabel("Title").fill("Pending private file")
    await form.getByLabel("File").setInputFiles({ name: "pending.txt", mimeType: "text/plain", buffer: Buffer.from("Pending encrypted file") })
    await form.getByRole("button", { name: "Attach", exact: true }).click()
    await detail.getByRole("button", { name: "Close detail", exact: true }).click()
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    await page.getByRole("tab", { name: "Rusty", exact: true }).click()
    const panel = page.getByRole("region", { name: "Rusty", exact: true })
    await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await panel.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(panel.locator(":scope > .rusty-connections").getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    await page.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    await open.click()
    const status = detail.getByRole("group", { name: "Pending private file" }).getByRole("status", { name: "Encrypted attachment coverage" })
    await expect(status).toContainText("Rusty unavailable", { timeout: 30_000 })
    await expect(status).not.toContainText("Complete on Rusty")
    const before = metadataUploads
    await detail.getByRole("textbox", { name: "Quick note", exact: true }).fill("Card saves while file upload waits")
    await detail.getByRole("button", { name: "Add note", exact: true }).click()
    await expect(detail.getByRole("textbox", { name: "Quick note", exact: true })).toHaveValue("")
    await expect.poll(() => metadataUploads, { timeout: 30_000 }).toBeGreaterThan(before)
    await expect(status).not.toContainText("Complete on Rusty")
  } finally { await rusty.close() }
})
