import { readFile } from "node:fs/promises"
import { expect, test, type Page } from "./support/coverage"
import { createJobSearchWorkspace, ensureJobSearchWorkspace } from "./support/workspaces"
import { startRustyService } from "./support/rustyService"
import { captureHistoryNativeFailures } from "./support/historyNativeFailure"
import { captureHistoryBackupProgress } from "./support/historyBackupProgress"
import { downloadPrivateWorkspaceRecovery } from "./support/workspaceRecoveryDownload"

const attachmentTitle = "Session recovery file"
const attachmentName = "session-recovery.txt"

type AttachmentRecoveryGate = {
  armed: boolean
  started: boolean
  held: boolean
  resets: number
  releaseResponse: Promise<void>
  release(): void
  closeConnection?: () => Promise<void>
  firstConnection?: unknown
  responseHeld?: boolean
  reconnected?: boolean
  failures?: Array<{ name?: string; message?: string }>
}

declare global {
  interface Window {
    __TINCANBAN_ATTACHMENT_RECOVERY_GATE__?: AttachmentRecoveryGate
    __TINCANBAN_ATTACHMENT_RECOVERY_SENTINEL__?: string
  }
}

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
  const item = page.getByRole("dialog", { name: "Lead details" })
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
  await item.getByRole("button", { name: "Close detail", exact: true }).click()

  const descriptor = await page.evaluate(async title => {
    const { useTincanban } = await import("/src/state.ts")
    const doc = useTincanban().getActiveDoc()
    if (!doc) throw new Error("Active workspace document is missing")
    const document = Object.values(doc.entities)
      .find(entity => entity.kind === "document" && entity.title === title)
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
      const observeRequest = async function(...args) {
        try { return await originalRequestBlob.apply(this, args) }
        catch (error) {
          const gate = window.__TINCANBAN_ATTACHMENT_RECOVERY_GATE__
          if (gate) (gate.failures ??= []).push({ message: String(error) })
          throw error
        }
      }
      requestBlob = async function(connection, secret, profile, scopeId, descriptor, options) {
        const gate = window.__TINCANBAN_ATTACHMENT_RECOVERY_GATE__
        if (!gate?.armed || descriptor.name !== "${attachmentName}") {
          return observeRequest.call(this, connection, secret, profile, scopeId, descriptor, options)
        }
        if (gate.started) {
          if (connection !== gate.firstConnection) gate.reconnected = true
          return observeRequest.call(this, connection, secret, profile, scopeId, descriptor, options)
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
        return observeRequest.call(this, requestConnection, secret, profile, scopeId, descriptor, options)
      }
    })()`
    await route.fulfill({ response, body: instrumented })
  })

  try {
    await pairWorkspace(page, guest)
    await guest.getByRole("button", { name: "Open Attachment recovery — Engineer" }).click()
    const remoteAttachment = guest.getByRole("group", { name: attachmentTitle })
    const expectedPreview = fileBytes.subarray(0, 32 * 1024).toString("utf8")
    await guest.evaluate(() => {
      let release!: () => void
      const releaseResponse = new Promise<void>(resolve => { release = resolve })
      window.__TINCANBAN_ATTACHMENT_RECOVERY_GATE__ = {
        armed: true,
        started: false,
        held: false,
        resets: 0,
        releaseResponse,
        release: () => release(),
      }
      window.__TINCANBAN_ATTACHMENT_RECOVERY_SENTINEL__ = "recipient route stayed mounted"
    })

    await remoteAttachment.getByRole("button", { name: "Preview" }).click()
    const preview = guest.getByRole("dialog", { name: "Document preview" })
    await expect.poll(() => guest.evaluate(() => window.__TINCANBAN_ATTACHMENT_RECOVERY_GATE__?.held)).toBe(true)
    await expect.poll(async () => guest.evaluate(async descriptorInput => {
      const { readStoredAttachment } = await import("/src/attachments.ts")
      return (await readStoredAttachment(descriptorInput)) !== undefined
    }, descriptor)).toBe(false)

    await guest.evaluate(async () => {
      const gate = window.__TINCANBAN_ATTACHMENT_RECOVERY_GATE__
      if (!gate.closeConnection) throw new Error("The real stream connection was not captured")
      await gate.closeConnection()
    })
    await expect.poll(() => guest.evaluate(() => window.__TINCANBAN_ATTACHMENT_RECOVERY_GATE__?.resets)).toBeGreaterThan(0)
    await expect.poll(() => guest.evaluate(() => window.__TINCANBAN_ATTACHMENT_RECOVERY_GATE__?.reconnected)).toBe(true)
    await expect(guest.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    await guest.evaluate(() => window.__TINCANBAN_ATTACHMENT_RECOVERY_GATE__?.release())

    try {
      await expect(preview.locator("pre.document-preview-text")).toHaveText(expectedPreview, { timeout: 30_000 })
    } catch (error) {
      const failures = await guest.evaluate(() => window.__TINCANBAN_ATTACHMENT_RECOVERY_GATE__?.failures ?? [])
      throw new Error(`Attachment preview failed after reconnect; request failures: ${JSON.stringify(failures)}`, { cause: error })
    }
    await expect(preview.getByText("Showing the beginning of this file. Download to read the full text.", { exact: true })).toBeVisible()
    expect(await guest.evaluate(() => window.__TINCANBAN_ATTACHMENT_RECOVERY_SENTINEL__)).toBe("recipient route stayed mounted")
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
    await guest.evaluate(() => window.__TINCANBAN_ATTACHMENT_RECOVERY_GATE__?.release?.()).catch(() => {})
    await guestContext.close()
  }
})

test("Given an archived owner baseline, when a credential-free editor receives it and restores a private backup offline, then archived versions remain readable and restorable", async ({ browser, baseURL }, testInfo) => {
  // CI WebKit reached identity restoration but exhausted the shared 180s budget.
  test.setTimeout(testInfo.project.name.includes("webkit") ? 240_000 : 180_000)
  const ownerContext = await browser.newContext()
  const editorContext = await browser.newContext({ acceptDownloads: true })
  const owner = await ownerContext.newPage()
  await captureHistoryNativeFailures(owner, test.info())
  owner.on("console", message => {
    if (message.text().startsWith("Workspace history archiving failed:")) console.error(message.text())
  })
  const editor = await editorContext.newPage()
  let rusty: Awaited<ReturnType<typeof startRustyService>> | undefined
  let ownerClosed = false
  let identityRecoveryBytes: Buffer | undefined
  let identityRecoveryWords = ""
  let workspaceRecoveryBytes: Buffer | undefined
  let workspaceRecoveryWords: string
  let workspaceId = ""

  async function makeIdentityRecovery() {
    await editor.getByRole("button", { name: "Settings", exact: true }).click()
    await editor.getByRole("button", { name: "Recovery backup", exact: true }).click()
    const dialog = editor.getByRole("dialog", { name: "Identity recovery" })
    const downloadEvent = editor.waitForEvent("download", { timeout: 30_000 })
    await dialog.getByRole("button", { name: "Generate and download recovery file", exact: true }).click()
    const download = await downloadEvent
    identityRecoveryBytes = await readFile((await download.path())!)
    identityRecoveryWords = (await dialog.locator(".recovery-words").innerText()).trim()
    if (!identityRecoveryWords) throw new Error("Identity recovery words were not generated")
    await editor.reload()
    await expect(editor.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
  }

  async function makeWorkspaceRecovery() {
    await editor.getByRole("button", { name: "Sync", exact: true }).click()
    const sync = editor.getByRole("dialog", { name: "Device sync" })
    await sync.getByRole("tab", { name: "Backups", exact: true }).click()
    const backups = sync.getByRole("region", { name: "Private workspace recovery" })
    const downloadEvent = editor.waitForEvent("download", { timeout: 60_000 })
    await backups.getByRole("button", { name: "Create private recovery backup", exact: true }).click()
    const download = await downloadEvent
    const fileBytes = await readFile((await download.path())!)
    const recoveryWords = await backups.getByLabel("Recovery words", { exact: true }).inputValue()
    if (!workspaceRecoveryBytes) {
      workspaceRecoveryBytes = fileBytes
      workspaceRecoveryWords = recoveryWords
    }
    await backups.locator('input[type="file"]').setInputFiles({ name: "workspace-recovery.jsonl", mimeType: "application/x-tincanban-history-recovery+jsonl", buffer: fileBytes })
    await backups.getByLabel("Recovery words to inspect").fill(recoveryWords)
    await backups.getByRole("button", { name: "Inspect recovery file", exact: true }).click()
    return backups
  }

  try {
    await owner.goto(baseURL!)
    await createJobSearchWorkspace(owner, "Cold history source")
    workspaceId = await owner.evaluate(async () => (await import("/src/state.ts")).useTincanban().activeWorkspace.id)
    const trustedOwner = await owner.evaluate(async () => {
      const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
      return { identity: profile.identity, allowedControllerDeviceIds: [profile.device.deviceId] }
    })
    rusty = await startRustyService(trustedOwner, baseURL!)

    const add = owner.getByRole("region", { name: "Lead" }).getByRole("button", { name: "Add lead to Lead" })
    await add.click()
    const form = owner.getByRole("dialog", { name: "Add item" })
    await form.getByLabel("Company *").fill("History Archive Company")
    await form.getByLabel("Role *").fill("Before archive")
    await form.getByRole("button", { name: "Create item", exact: true }).click()
    const ownerDetail = owner.getByRole("dialog", { name: "Lead details" })
    if (!await ownerDetail.isVisible()) await owner.getByRole("button", { name: "Open History Archive Company — Before archive", exact: true }).click()
    await ownerDetail.getByRole("button", { name: "Edit", exact: true }).click()
    const edit = owner.getByRole("dialog", { name: "Edit item" })
    await edit.getByLabel("Role *").fill("After archive")
    await edit.getByRole("button", { name: "Save changes", exact: true }).click()
    await ownerDetail.getByRole("button", { name: "Close detail", exact: true }).click()

    await owner.getByRole("button", { name: "Sync", exact: true }).click()
    const ownerSync = owner.getByRole("dialog", { name: "Device sync" })
    await ownerSync.getByRole("tab", { name: "Rusty", exact: true }).click()
    const rustyPanel = owner.getByRole("region", { name: "Rusty", exact: true })
    await rustyPanel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await rustyPanel.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await rustyPanel.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(rustyPanel.locator(":scope > .rusty-connections").getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    await ownerSync.getByRole("tab", { name: "Backups", exact: true }).click()
    const maintenance = ownerSync.getByRole("region", { name: "Workspace history" })
    await maintenance.getByRole("button", { name: "Archive older history", exact: true }).click()
    await expect(maintenance.getByRole("status").filter({ hasText: "Older history archived" })
      .or(maintenance.getByRole("alert"))).toBeVisible({ timeout: 60_000 })
    await expect(maintenance.getByRole("alert")).toHaveCount(0)
    await expect(maintenance.getByRole("status").filter({ hasText: "Older history archived" })).toContainText("Older history archived")

    // Capacity failure must be legible and leave the already admitted history usable.
    const baselineBeforeCapacityFailure = await owner.evaluate(async id =>
      (await (await import("/src/storage.ts")).defaultStorage.ensureHistoryProgress(id)).baselineId, workspaceId)
    await owner.evaluate(async () => {
      const storage = await import("/src/storage.ts")
      const target = storage.defaultStorage as typeof storage.defaultStorage & { __originalClaim?: typeof storage.defaultStorage.claimHistoryTransitionId }
      target.__originalClaim = target.claimHistoryTransitionId.bind(target)
      target.claimHistoryTransitionId = async () => { throw new DOMException("Injected storage capacity failure", "QuotaExceededError") }
    })
    try {
      await maintenance.getByRole("button", { name: "Archive older history", exact: true }).click()
      await expect(maintenance.getByRole("alert")).toHaveText("Browser storage is full. Free up space, then retry archiving history.")
      expect(await owner.evaluate(async id => {
        const storage = (await import("/src/storage.ts")).defaultStorage
        return { workspaceId: (await storage.loadWorkspaceDoc(id))?.doc.id,
          baselineId: (await storage.ensureHistoryProgress(id)).baselineId }
      }, workspaceId)).toEqual({ workspaceId, baselineId: baselineBeforeCapacityFailure })
    } finally {
      await owner.evaluate(async () => {
        const storage = await import("/src/storage.ts")
        const target = storage.defaultStorage as typeof storage.defaultStorage & { __originalClaim?: typeof storage.defaultStorage.claimHistoryTransitionId }
        if (target.__originalClaim) target.claimHistoryTransitionId = target.__originalClaim
        delete target.__originalClaim
      })
    }
    await ownerSync.getByRole("button", { name: "Close", exact: true }).click()

    // A different authorized person proves the peer path does not depend on private Rusty credentials.
    await owner.getByRole("button", { name: "Sync", exact: true }).click()
    const inviteDialog = owner.getByRole("dialog", { name: "Device sync" })
    await inviteDialog.getByRole("button", { name: "Add someone", exact: true }).click()
    await inviteDialog.getByRole("button", { name: "Generate link", exact: true }).click()
    await editor.goto(await inviteDialog.getByLabel("Pairing link").inputValue())
    const join = editor.getByRole("dialog", { name: "Device sync" })
    await join.getByRole("button", { name: "Accept and join", exact: true }).click()
    await owner.getByLabel("Participant role").selectOption("editor")
    await owner.getByRole("button", { name: "Approve access", exact: true }).click()
    await expect(editor.getByLabel("Mesh connected")).toBeVisible({ timeout: 30_000 })
    const access = await editor.evaluate(async origin => {
      const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
      const configs = await (await import("/src/sync/privateReplicaRepository.ts")).getReplicaConfigurations(profile.identity.personId)
      return { personId: profile.identity.personId, configs: configs.filter(config => config.origin === origin) }
    }, rusty.origin)
    expect(access.personId).not.toBe(trustedOwner.identity.personId)
    expect(access.configs).toEqual([])
    await join.getByRole("button", { name: "Close", exact: true }).click()

    // Count selected peer archive reads at the actual reader port. This guards against a full-archive scan.
    await editor.route("**/src/sync/historyArchiveReader.ts*", async route => {
      const response = await route.fetch()
      const source = await response.text()
      if (!/export\s+function\s+createHistoryArchiveReader\s*\(/.test(source)) {
        throw new Error("History archive reader module has no createHistoryArchiveReader function to instrument")
      }
      const instrumented = `${source}\n;(() => {
        const originalCreateHistoryArchiveReader = createHistoryArchiveReader
        createHistoryArchiveReader = function(input) {
          if (!input.peerFetch) return originalCreateHistoryArchiveReader(input)
          const originalRead = input.peerFetch.read
          const peerFetch = { ...input.peerFetch, read: async function(objectId, binding) {
            const bytes = await originalRead(objectId, binding)
            ;(window.__TINCANBAN_HISTORY_READS__ ??= []).push({ objectId, binding, byteLength: bytes?.byteLength ?? null })
            return bytes
          } }
          return originalCreateHistoryArchiveReader({ ...input, peerFetch })
        }
      })()`
      await route.fulfill({ response, body: instrumented })
    })

    const card = editor.getByRole("button", { name: "Open History Archive Company — After archive", exact: true })
    await expect(card).toBeVisible({ timeout: 30_000 })
    await card.click()
    const detail = editor.getByRole("dialog", { name: "Lead details" })
    await detail.getByRole("button", { name: "Load earlier history", exact: true }).click()
    const originalVersion = detail.locator(".item-history-entry").filter({ hasText: "createItem" })
    await expect(originalVersion.getByRole("button", { name: "Restore this version", exact: true })).toBeVisible({ timeout: 30_000 })
    const selectedReads = await editor.evaluate(() => (window as Window & { __TINCANBAN_HISTORY_READS__?: Array<{ objectId: string; binding: { workspaceId: string; historyEpoch: number; indexId: string; objectKind: string; partCount: number; partIndex: number }; byteLength: number | null }> }).__TINCANBAN_HISTORY_READS__ ?? [])
    expect(selectedReads.length).toBeGreaterThan(0)
    expect(selectedReads.length).toBeLessThan(256)
    expect(selectedReads.every(read => /^[A-Za-z0-9_-]{43}$/.test(read.objectId) && read.binding.workspaceId === workspaceId &&
      Number.isSafeInteger(read.binding.historyEpoch) && /^([a-z][a-z0-9-]{0,63}|change\/|entity\/|source-proof\/)/.test(read.binding.indexId) &&
      ["page", "record", "part"].includes(read.binding.objectKind) && read.binding.partCount > 0 &&
      read.binding.partIndex >= 0 && read.binding.partIndex < read.binding.partCount &&
      (read.byteLength ?? 0) <= (read.binding.objectKind === "part" ? 256 : 64) * 1024)).toBe(true)
    await detail.getByRole("button", { name: "Close detail", exact: true }).click()

    await makeIdentityRecovery()
    const complete = await makeWorkspaceRecovery()
    await expect(complete.getByText("Coverage: Complete backup", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(complete.getByRole("button", { name: "Restore recovered workspace", exact: true })).toBeDisabled()
    const completeWorkspaceRecoveryBytes = workspaceRecoveryBytes!
    const completeWorkspaceRecoveryWords = workspaceRecoveryWords
    await editor.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()
    await inviteDialog.getByRole("button", { name: "Close", exact: true }).click()

    // A second export after both sources close must report unavailable archive objects without losing baseline admission evidence.
    await ownerContext.close()
    ownerClosed = true
    await rusty.close()
    rusty = undefined
    const incomplete = await makeWorkspaceRecovery()
    await expect(incomplete.getByText(/Incomplete backup · [1-9][0-9]* items unavailable/)).toBeVisible({ timeout: 30_000 })
    await editor.getByRole("dialog", { name: "Device sync" }).getByRole("button", { name: "Close", exact: true }).click()

    const recovery = await browser.newContext({ acceptDownloads: true })
    const restored = await recovery.newPage()
    try {
      await restored.goto(baseURL!)
      await restored.getByRole("button", { name: "Settings", exact: true }).click()
      await restored.getByRole("button", { name: "Recovery backup", exact: true }).click()
      const identityDialog = restored.getByRole("dialog", { name: "Identity recovery" })
      await identityDialog.getByRole("button", { name: "Restore from backup", exact: true }).click()
      await identityDialog.getByLabel("Recovery words").fill(identityRecoveryWords)
      await identityDialog.getByLabel("Recovery file").setInputFiles({ name: "identity-recovery.json", mimeType: "application/json", buffer: identityRecoveryBytes! })
      await identityDialog.getByRole("checkbox").check()
      await Promise.all([restored.waitForEvent("load"), identityDialog.getByRole("button", { name: "Restore identity", exact: true }).click()])

      await restored.getByRole("button", { name: "Sync", exact: true }).click()
      const sync = restored.getByRole("dialog", { name: "Device sync" })
      await sync.getByRole("tab", { name: "Backups", exact: true }).click()
      const backups = sync.getByRole("region", { name: "Private workspace recovery" })
      await backups.locator('input[type="file"]').setInputFiles({ name: "complete-workspace.jsonl", mimeType: "application/x-tincanban-history-recovery+jsonl", buffer: completeWorkspaceRecoveryBytes })
      await backups.getByLabel("Recovery words to inspect").fill(completeWorkspaceRecoveryWords)
      await backups.getByRole("button", { name: "Inspect recovery file", exact: true }).click()
      await expect(backups.getByText("Coverage: Complete backup", { exact: true })).toBeVisible()
      await backups.getByRole("button", { name: "Restore recovered workspace", exact: true }).click()
      await expect(backups.getByRole("status")).toContainText("Workspace recovery restored", { timeout: 30_000 })
      await sync.getByRole("button", { name: "Close", exact: true }).click()
      await restored.getByRole("button", { name: "Open workspaces", exact: true }).click()
      await restored.getByRole("dialog", { name: "Workspaces" }).locator(".workspace-item")
        .filter({ hasText: "Cold history source" }).getByRole("button", { name: /^Cold history source Owner:/ }).click()
      await expect(restored.getByRole("button", { name: "Open History Archive Company — After archive", exact: true })).toBeVisible()
      await restored.getByRole("button", { name: "Open History Archive Company — After archive", exact: true }).click()
      const restoredDetail = restored.getByRole("dialog", { name: "Lead details" })
      await restoredDetail.getByRole("button", { name: "Load earlier history", exact: true }).click()
      const restoredOriginal = restoredDetail.locator(".item-history-entry").filter({ hasText: "createItem" })
      await expect(restoredOriginal.getByRole("button", { name: "Restore this version", exact: true })).toBeVisible({ timeout: 30_000 })
      await restoredOriginal.getByRole("button", { name: "Restore this version", exact: true }).click()
      await expect(restoredDetail.getByText("Version restored", { exact: true })).toBeVisible()
      await restoredDetail.getByRole("button", { name: "Close detail", exact: true }).click()
      await expect(restored.getByRole("button", { name: "Open History Archive Company — Before archive", exact: true })).toBeVisible()
    } finally { await recovery.close() }
  } finally {
    if (!ownerClosed) await ownerContext.close()
    await editorContext.close()
    await rusty?.close()
  }
})

test("Given an owner with two archived history generations, when adding my phone, then its backup covers both generations and it restores an original version with the owner device closed", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(210_000)
  const sourceContext = await browser.newContext({ acceptDownloads: true })
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const source = await sourceContext.newPage()
  const attachBackupProgress = await captureHistoryBackupProgress(source, testInfo)
  const phone = await phoneContext.newPage()
  let workspaceRecoveryBytes: Buffer | undefined
  let workspaceRecoveryWords: string
  let sourceClosed = false
  let rusty: Awaited<ReturnType<typeof startRustyService>> | undefined
  try {
    await source.goto(baseURL!)
    await createJobSearchWorkspace(source, "Enrolled phone history")
    await expect(source.getByLabel("Workspace role: owner", { exact: true })).toBeVisible({ timeout: 15_000 })
    const trustedOwner = await source.evaluate(async () => {
      const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
      return { identity: profile.identity, allowedControllerDeviceIds: [profile.device.deviceId] }
    })
    rusty = await startRustyService(trustedOwner, baseURL!)
    await source.getByRole("button", { name: "Add lead to Lead", exact: true }).click()
    const add = source.getByRole("dialog", { name: "Add item" })
    await add.getByLabel("Company *").fill("Enrolled history")
    await add.getByLabel("Role *").fill("Original position")
    await add.getByRole("button", { name: "Create item", exact: true }).click()
    const detail = source.getByRole("dialog", { name: "Lead details" })
    if (!await detail.isVisible()) await source.getByRole("button", { name: "Open Enrolled history — Original position", exact: true }).click()
    await detail.getByRole("button", { name: "Edit", exact: true }).click()
    const edit = source.getByRole("dialog", { name: "Edit item" })
    await edit.getByLabel("Role *").fill("Current position")
    await edit.getByRole("button", { name: "Save changes", exact: true }).click()
    await detail.getByRole("button", { name: "Close detail", exact: true }).click()
    await source.getByRole("button", { name: "Sync", exact: true }).click()
    const host = source.getByRole("dialog", { name: "Device sync" })
    await host.getByRole("tab", { name: "Rusty", exact: true }).click()
    const panel = host.getByRole("region", { name: "Rusty", exact: true })
    await panel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await panel.getByLabel("Address", { exact: true }).fill(rusty.origin)
    await panel.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(panel.locator(":scope > .rusty-connections").getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    await host.getByRole("tab", { name: "Backups", exact: true }).click()
    const maintenance = host.getByRole("region", { name: "Workspace history" })
    await maintenance.getByRole("button", { name: "Archive older history", exact: true }).click()
    await expect(maintenance.getByRole("status").filter({ hasText: "Older history archived" }).or(maintenance.getByRole("alert")))
      .toBeVisible({ timeout: 60_000 })
    await expect(maintenance.getByRole("alert")).toHaveCount(0)
    await host.getByRole("button", { name: "Close", exact: true }).click()
    await source.getByRole("button", { name: "Open Enrolled history — Current position", exact: true }).click()
    await detail.getByRole("button", { name: "Edit", exact: true }).click()
    await edit.getByLabel("Role *").fill("Latest position")
    await edit.getByRole("button", { name: "Save changes", exact: true }).click()
    await detail.getByRole("button", { name: "Close detail", exact: true }).click()
    await source.getByRole("button", { name: "Sync", exact: true }).click()
    await host.getByRole("tab", { name: "Rusty", exact: true }).click()
    await expect(panel.locator(":scope > .rusty-connections").getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    await host.getByRole("tab", { name: "Backups", exact: true }).click()
    await maintenance.getByRole("button", { name: "Archive older history", exact: true }).click()
    await expect(maintenance.getByRole("status").filter({ hasText: "Older history archived" }).or(maintenance.getByRole("alert")))
      .toBeVisible({ timeout: 60_000 })
    await expect(maintenance.getByRole("alert")).toHaveCount(0)
    await host.getByRole("button", { name: "Close", exact: true }).click()
    await source.getByRole("button", { name: "Sync", exact: true }).click()
    await host.getByRole("button", { name: "Add someone", exact: true }).click()
    await host.getByRole("button", { name: "Add my device", exact: true }).click()
    await phone.goto(await host.getByLabel("Pairing link").inputValue())
    const enrollment = phone.getByRole("dialog", { name: "Device sync" })
    await expect(enrollment.getByRole("button", { name: "Add this device", exact: true })).toBeVisible()
    const replace = enrollment.getByRole("checkbox", { name: /Replace this device.s identity/ })
    if (await replace.count()) await replace.check()
    await enrollment.getByRole("button", { name: "Add this device", exact: true }).click()
    await expect(host.getByRole("button", { name: "Approve device", exact: true })).toBeVisible({ timeout: 30_000 })
    await host.getByRole("button", { name: "Approve device", exact: true }).click()
    await expect(enrollment.getByText("Device enrolled", { exact: true })).toBeVisible({ timeout: 30_000 })
    await enrollment.getByRole("button", { name: "Close", exact: true }).click()
    await phone.getByRole("button", { name: "Menu", exact: true }).click()
    await phone.getByRole("button", { name: "Sync & backups", exact: true }).click()
    const phoneSync = phone.getByRole("dialog", { name: "Device sync" })
    await phoneSync.getByRole("tab", { name: "Rusty", exact: true }).click()
    await expect(phoneSync.getByRole("region", { name: "Rusty", exact: true }).locator(":scope > .rusty-connections")
      .getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })

    await host.getByRole("button", { name: "Close", exact: true }).click()
    await source.getByRole("button", { name: "Sync", exact: true }).click()
    const ownerSync = source.getByRole("dialog", { name: "Device sync" })
    await ownerSync.getByRole("tab", { name: "Backups", exact: true }).click()
    const ownerBackups = ownerSync.getByRole("region", { name: "Private workspace recovery" })
    // Full recovery verifies both generations before publishing the encrypted file.
    // Enrollment may finish a protected admission-checkpoint refresh during capture.
    // Observe that explicit rejection and retry a fresh full file; all attempts share 60 seconds.
    const ownerBackup = await downloadPrivateWorkspaceRecovery(source, ownerBackups)
      .catch(async error => { await attachBackupProgress(); throw error })
    workspaceRecoveryBytes = await readFile((await ownerBackup.path())!)
    workspaceRecoveryWords = await ownerBackups.getByLabel("Recovery words", { exact: true }).inputValue()
    await ownerBackups.locator('input[type="file"]').setInputFiles({ name: "two-generations.jsonl", mimeType: "application/x-tincanban-history-recovery+jsonl", buffer: workspaceRecoveryBytes })
    await ownerBackups.getByLabel("Recovery words to inspect").fill(workspaceRecoveryWords)
    await ownerBackups.getByRole("button", { name: "Inspect recovery file", exact: true }).click()
    await expect(ownerBackups.getByText("Coverage: Complete backup", { exact: true })).toBeVisible({ timeout: 30_000 })
    await ownerSync.getByRole("button", { name: "Close", exact: true }).click()
    await sourceContext.close()
    sourceClosed = true

    await phoneSync.getByRole("tab", { name: "Backups", exact: true }).click()
    const phoneBackups = phoneSync.getByRole("region", { name: "Private workspace recovery" })
    await expect(phoneBackups.getByRole("button", { name: "Create private recovery backup", exact: true })).toBeDisabled()
    await expect(phoneBackups.getByText("Create a full backup on your original device. You can inspect and restore backups here.", { exact: true })).toBeVisible()
    await phoneBackups.locator('input[type="file"]').setInputFiles({ name: "two-generations.jsonl", mimeType: "application/x-tincanban-history-recovery+jsonl", buffer: workspaceRecoveryBytes! })
    await phoneBackups.getByLabel("Recovery words to inspect").fill(workspaceRecoveryWords)
    await phoneBackups.getByRole("button", { name: "Inspect recovery file", exact: true }).click()
    await expect(phoneBackups.getByText("Coverage: Complete backup", { exact: true })).toBeVisible({ timeout: 30_000 })
    await phoneSync.getByRole("button", { name: "Close", exact: true }).click()
    await phone.getByRole("button", { name: "Open Enrolled history — Latest position", exact: true }).click()
    const phoneDetail = phone.getByRole("dialog", { name: "Lead details" })
    const original = phoneDetail.locator(".item-history-entry").filter({ hasText: "createItem" })
    const historyEntries = phoneDetail.locator(".item-history-entry")
    for (let page = 0; page < 4 && !(await original.count()); page++) {
      const before = await historyEntries.count()
      await phoneDetail.getByRole("button", { name: "Load earlier history", exact: true }).click()
      await expect.poll(() => historyEntries.count(), { timeout: 15_000 }).toBeGreaterThan(before)
      await expect(phoneDetail.getByRole("status").filter({ hasText: "Reading archived versions…" }))
        .toHaveCount(0, { timeout: 30_000 })
    }
    await expect(original.getByRole("button", { name: "Restore this version", exact: true })).toBeVisible({ timeout: 30_000 })
    await original.getByRole("button", { name: "Restore this version", exact: true }).click()
    // Restoring an archived version reads its original encrypted objects from
    // the retained history source before committing the workspace command.
    await expect(phoneDetail.getByText("Version restored", { exact: true })).toBeVisible({ timeout: 30_000 })
    await phoneDetail.getByRole("button", { name: "Close detail", exact: true }).click()
    await expect(phone.getByRole("button", { name: "Open Enrolled history — Original position", exact: true })).toBeVisible()
  } finally {
    if (!sourceClosed) await sourceContext.close()
    await phoneContext.close()
    await rusty?.close()
  }
})
