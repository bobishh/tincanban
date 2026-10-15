import { readFile } from "node:fs/promises"
import { expect, test, type Page } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

const attachmentTitle = "Session recovery file"
const attachmentName = "session-recovery.txt"

async function addLead(page: Page, company: string) {
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill(company)
  await page.getByLabel("Role *").fill("Engineer")
  await page.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

async function pairWorkspace(host: Page, guest: Page) {
  await host.getByRole("button", { name: "Sync", exact: true }).click()
  const hostDialog = host.getByRole("dialog", { name: "Device sync" })
  await hostDialog.getByRole("button", { name: "Add someone" }).click()
  await hostDialog.getByRole("button", { name: "Generate link" }).click()
  const invite = await hostDialog.getByLabel("Pairing link").inputValue()
  await guest.goto(invite)
  const guestDialog = guest.getByRole("dialog", { name: "Device sync" })
  await guestDialog.getByRole("button", { name: "Accept and join" }).click()
  await host.getByLabel("Participant role").selectOption("editor")
  await host.getByRole("button", { name: "Approve access" }).click()
  await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
  await expect(guest.getByLabel("Workspace role: editor")).toBeVisible()
  if (await guestDialog.isVisible()) await guestDialog.getByRole("button", { name: "Close", exact: true }).first().click()
  if (await hostDialog.isVisible()) await hostDialog.getByRole("button", { name: "Close", exact: true }).first().click()
}

test("Given a multi-chunk attachment transfer loses its stream, when the recipient reconnects, then preview and download recover without publishing partial bytes", async ({ browser, page }) => {
  test.setTimeout(120_000)
  await page.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  await page.goto("/")
  await addLead(page, "Attachment recovery")
  await page.getByRole("button", { name: "Open Attachment recovery — Engineer" }).click()
  const item = page.getByRole("dialog", { name: "Item overview" })
  await item.getByRole("button", { name: "+ File" }).click()
  const fileBytes = Buffer.from("stream recovery payload\n".repeat(40_000))
  const attachmentForm = item.getByRole("form", { name: "Attach document" })
  await attachmentForm.getByLabel("Title").fill(attachmentTitle)
  await attachmentForm.getByLabel("File").setInputFiles({
    name: attachmentName,
    mimeType: "text/plain",
    buffer: fileBytes,
  })
  await attachmentForm.getByRole("button", { name: "Attach" }).click()
  await expect(item.getByRole("group", { name: attachmentTitle })).toBeVisible()
  await item.getByRole("button", { name: "Dismiss" }).click()

  const descriptor = await page.evaluate(async title => {
    const { useTincanban } = await import("/src/state.ts")
    const doc = useTincanban().getActiveDoc()
    if (!doc) throw new Error("Active workspace document is missing")
    const document = Object.values(doc.entities)
      .find((entity: any) => entity.kind === "document" && entity.title === title) as any
    if (!document?.file) throw new Error("Saved attachment reference is missing")
    const descriptor = (await import("/src/attachments.ts")).blobDescriptor(document.file)
    if (!descriptor) throw new Error("Saved attachment descriptor is missing")
    return descriptor
  }, attachmentTitle)
  expect(descriptor).toMatchObject({ name: attachmentName, size: fileBytes.byteLength })
  expect(fileBytes.byteLength).toBeGreaterThan(2 * 256 * 1024)

  const guestContext = await browser.newContext({ acceptDownloads: true })
  await guestContext.route("**/api/sync-signal**", route => route.fulfill({ status: 404 }))
  const guest = await guestContext.newPage()
  await guest.route("**/mesh-blob/src/index.ts*", async route => {
    const response = await route.fetch()
    const source = await response.text()
    if (!/export\s+async\s+function\s+requestBlob\s*\(/.test(source)) {
      throw new Error("Vite mesh-blob module has no requestBlob function to instrument")
    }
    const instrumented = `${source}\n;(() => {
      const originalRequestBlob = requestBlob
      requestBlob = async function(connection, secret, profile, scopeId, descriptor, options) {
        const gate = window.__TINCANBAN_ATTACHMENT_RECOVERY_GATE__
        if (!gate?.armed || descriptor.name !== "${attachmentName}") {
          return originalRequestBlob(connection, secret, profile, scopeId, descriptor, options)
        }
        if (gate.started) {
          if (connection !== gate.firstConnection) gate.reconnected = true
          return originalRequestBlob(connection, secret, profile, scopeId, descriptor, options)
        }
        gate.started = true
        gate.firstConnection = connection
        const originalClose = connection.close.bind(connection)
        gate.closeConnection = () => originalClose()
        const requestConnection = {
          openStream: async function(...streamArgs) {
            const stream = await connection.openStream.apply(connection, streamArgs)
            if (gate.responseHeld) return stream
            const originalRead = stream.read
            const originalReset = stream.reset
            return {
              send: (...sendArgs) => stream.send.apply(stream, sendArgs),
              closeSend: (...closeArgs) => stream.closeSend.apply(stream, closeArgs),
              read: async (...readArgs) => {
                gate.responseHeld = true
                const response = Promise.resolve().then(() => originalRead.apply(stream, readArgs))
                response.then(() => undefined, () => undefined)
                gate.held = true
                await gate.releaseResponse
                return response
              },
              ...(typeof originalReset === "function" ? {
                reset: async (...resetArgs) => {
                  try { return await originalReset.apply(stream, resetArgs) }
                  finally { gate.resets += 1 }
                },
              } : {}),
            }
          }
        }
        return originalRequestBlob(requestConnection, secret, profile, scopeId, descriptor, options)
      }
    })()`
    await route.fulfill({ response, body: instrumented })
  })

  try {
    await pairWorkspace(page, guest)
    await guest.getByRole("button", { name: "Open Attachment recovery — Engineer" }).click()
    const remoteAttachment = guest.getByRole("group", { name: attachmentTitle })
    const expectedPreview = fileBytes.toString("utf8")
    await guest.evaluate(() => {
      let release!: () => void
      const releaseResponse = new Promise<void>(resolve => { release = resolve })
      ;(window as any).__TINCANBAN_ATTACHMENT_RECOVERY_GATE__ = {
        armed: true,
        started: false,
        held: false,
        resets: 0,
        releaseResponse,
        release: () => release(),
      }
      ;(window as any).__TINCANBAN_ATTACHMENT_RECOVERY_SENTINEL__ = "recipient route stayed mounted"
    })

    await remoteAttachment.getByRole("button", { name: "Preview" }).click()
    const preview = guest.getByRole("dialog", { name: "Document preview" })
    await expect.poll(() => guest.evaluate(() => (window as any).__TINCANBAN_ATTACHMENT_RECOVERY_GATE__?.held)).toBe(true)
    await expect.poll(async () => guest.evaluate(async descriptorInput => {
      const { readStoredAttachment } = await import("/src/attachments.ts")
      return (await readStoredAttachment(descriptorInput)) !== undefined
    }, descriptor)).toBe(false)

    await guest.evaluate(async () => {
      const gate = (window as any).__TINCANBAN_ATTACHMENT_RECOVERY_GATE__
      if (!gate.closeConnection) throw new Error("The real stream connection was not captured")
      await gate.closeConnection()
    })
    await expect.poll(() => guest.evaluate(() => (window as any).__TINCANBAN_ATTACHMENT_RECOVERY_GATE__?.resets)).toBeGreaterThan(0)
    await expect.poll(() => guest.evaluate(() => (window as any).__TINCANBAN_ATTACHMENT_RECOVERY_GATE__?.reconnected)).toBe(true)
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await guest.evaluate(() => (window as any).__TINCANBAN_ATTACHMENT_RECOVERY_GATE__.release())

    await expect(preview.locator("pre.document-preview-text")).toHaveText(expectedPreview, { timeout: 30_000 })
    expect(await guest.evaluate(() => (window as any).__TINCANBAN_ATTACHMENT_RECOVERY_SENTINEL__)).toBe("recipient route stayed mounted")
    await preview.getByRole("button", { name: "Close" }).click()

    const downloadStarted = guest.waitForEvent("download")
    await remoteAttachment.getByRole("button", { name: "Download" }).click()
    const download = await downloadStarted
    expect(download.suggestedFilename()).toBe(attachmentName)
    const downloadedPath = await download.path()
    expect(downloadedPath).toBeTruthy()
    expect(await readFile(downloadedPath!)).toEqual(fileBytes)
    await expect(guest.getByRole("button", { name: "Open Attachment recovery — Engineer" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Open Attachment recovery — Engineer" })).toBeVisible()
    await expect.poll(async () => guest.evaluate(async descriptorInput => {
      const { readStoredAttachment } = await import("/src/attachments.ts")
      return (await readStoredAttachment(descriptorInput)) !== undefined
    }, descriptor)).toBe(true)
  } finally {
    await guest.evaluate(() => (window as any).__TINCANBAN_ATTACHMENT_RECOVERY_GATE__?.release?.()).catch(() => {})
    await guestContext.close()
  }
})
