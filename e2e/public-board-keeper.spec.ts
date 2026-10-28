import { expect, test } from "@playwright/test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { discussObject } from "./support/discussions"
import { verifyPublicOwnerPollingDraft } from "./support/publicOwnerPolling"
import { approveRustyForFixture } from "./support/identityRustyFixture"

test("Given an owner publishes a board, when Keeper restarts and the owner withdraws it, then anonymous readers get only the active snapshot and file bytes", async ({ page, browser, baseURL }, info) => {
  test.setTimeout(120_000)
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Public release fixture")

  await create.getByRole("button", { name: "Create", exact: true }).click()

  await page.getByRole("button", { name: "Add item to To do" }).click()
  const itemForm = page.getByRole("dialog", { name: "Item details" })
  await itemForm.getByLabel("Title *").fill("Public release card")
  await itemForm.getByLabel("Body").fill("First published description")
  await itemForm.getByRole("button", { name: "Save item" }).click()
  await page.getByRole("button", { name: "Open Public release card" }).click()
  const detail = page.getByRole("dialog", { name: "Item overview" })
  await detail.getByRole("button", { name: "+ File" }).click()
  const fileForm = detail.getByRole("form", { name: "Attach document" })
  await fileForm.getByLabel("Title").fill("Release handout")
  await fileForm.getByLabel("File").setInputFiles({ name: "release.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 0xff, 0x41]) })
  await fileForm.getByRole("button", { name: "Attach" }).click()
  await detail.getByRole("button", { name: "Close detail" }).click()
  await page.getByRole("button", { name: "Open Public release card" }).click()
  const cardDetail = page.getByRole("dialog", { name: "Item overview" })
  await discussObject(page, cardDetail)
  const discussion = page.getByRole("dialog", { name: /^Discussion/ }).last()
  await discussion.getByRole("textbox", { name: "Message", exact: true }).fill("Public release discussion")
  await discussion.getByRole("button", { name: "Send message" }).click()
  await expect(discussion.getByText("Public release discussion", { exact: true })).toBeVisible()
  await expect(discussion.getByText("Saving locally…", { exact: true })).toHaveCount(0)
  const storedDiscussion = await page.evaluate(async () => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const chat = await (await import("/src/chat/service.ts")).loadChat(state.activeWorkspace.id)
    return { workspaceId: state.activeWorkspace.id, chat: chat.messages.map(message => ({ body: message.body, context: message.context })) }
  })
  expect(storedDiscussion.chat.some(message => message.body === "Public release discussion")).toBe(true)
  await discussion.getByRole("button", { name: "Close", exact: true }).click()
  if (await cardDetail.count()) await cardDetail.getByRole("button", { name: "Close detail" }).click()

  const fixture = await page.evaluate(async () => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const profile = await (await import("/src/domain/identity.ts")).bootstrapIdentity()
    return { boardId: state.activeBoard.value!.id, identity: profile.identity, deviceId: profile.device.deviceId }
  })
  const origin = process.env.TINCANBAN_PUBLIC_E2E_KEEPER_ORIGIN!
  const port = Number(process.env.TINCANBAN_PUBLIC_E2E_KEEPER_PORT)
  const directory = await mkdtemp(join(tmpdir(), "rusty-public-board-"))
  const trustedOwner = { identity: fixture.identity, allowedControllerDeviceIds: [fixture.deviceId] }
  let child: ChildProcess | undefined
  const start = () => new Promise<void>((resolveStart, reject) => {
    child = spawn(resolve(process.env.TINCANBAN_RUSTY_BINARY ?? "../mesh-lighthouse/target/debug/mesh-lighthouse"), [directory, `127.0.0.1:${port}`], {
      env: { RUSTY_TRUSTED_OWNER: JSON.stringify(trustedOwner), RUSTY_PUBLIC_ORIGIN: origin, RUSTY_CORS_ORIGINS: baseURL! },
    })
    const timer = setTimeout(() => reject(new Error("Keeper did not start")), 10_000)
    child.stdout?.on("data", chunk => { if (String(chunk).includes("listening on")) { clearTimeout(timer); resolveStart() } })
    child.stderr?.on("data", chunk => { if (/error|failed/i.test(String(chunk))) reject(new Error(String(chunk))) })
    child.once("error", reject)
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Keeper exited ${code}`)) })
  })
  const stop = async () => {
    const current = child!
    const exited = new Promise<void>(resolveExit => current.once("exit", () => resolveExit()))
    current.kill("SIGTERM")
    await exited
    child = undefined
  }
  let anonymousContext: Awaited<ReturnType<typeof browser.newContext>> | undefined
  // Given a selected board, when its owner opens Workspace settings, then
  // publication controls live there and never in the board toolbar.
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  const openPublication = async () => {
    await expect(page.getByRole("button", { name: "Publish board", exact: true })).toHaveCount(0)
    if (await page.getByRole("button", { name: "Menu", exact: true }).isVisible()) {
      await page.getByRole("button", { name: "Menu", exact: true }).click()
      await page.getByRole("dialog").getByRole("button", { name: "Settings", exact: true }).click()
    } else await page.getByRole("button", { name: "Settings", exact: true }).click()
    await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
    await expect(settings).toContainText("Public release fixture")
    return settings.getByRole("region", { name: "Public board access" })
  }
  try {
    const unavailable = await openPublication()
    await expect(unavailable).toContainText("Connect Rusty to this board to enable public access.")
    await expect(unavailable.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
    await start()
    await approveRustyForFixture(page, origin)
    await page.getByRole("button", { name: "Sync", exact: true }).click()
    const syncDialog = page.getByRole("dialog", { name: "Device sync" })

    const rustyPanel = syncDialog.getByRole("region", { name: "Rusty", exact: true })
    await rustyPanel.getByRole("button", { name: "Add Rusty", exact: true }).click()
    await rustyPanel.getByLabel("Address", { exact: true }).fill(origin)
    await rustyPanel.getByRole("button", { name: "Connect", exact: true }).click()
    await expect(rustyPanel.locator(".rusty-connections .rusty-connection").first().getByText("Synced", { exact: true })).toBeVisible({ timeout: 30_000 })
    await syncDialog.getByRole("button", { name: "Close", exact: true }).click()
    let panel = await openPublication()
    // Rusty starts after private board setup, so recover any earlier offline or
    // policy-initialization check through the visible owner action.
    const publicSwitch = panel.getByRole("switch", { name: "Public board", exact: true })
    await expect(async () => {
      if (await publicSwitch.isEnabled()) return
      const retry = panel.getByRole("button", { name: "Retry", exact: true })
      if (await retry.isVisible()) await retry.click({ timeout: 1_000 })
      await expect(publicSwitch).toBeEnabled({ timeout: 1_000 })
    }).toPass({ timeout: 30_000, intervals: [250, 500, 1_000] })
    await expect(panel.getByRole("switch", { name: "Public board", exact: true })).not.toBeChecked()
    await panel.getByRole("switch", { name: "Public board", exact: true }).click()
    await expect(panel.getByRole("switch", { name: "Public board", exact: true })).not.toBeChecked()
    await expect(panel.getByRole("group", { name: "Confirm public board change" })).toBeVisible()
    await panel.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(panel.getByRole("switch", { name: "Public board", exact: true })).not.toBeChecked()
    await panel.getByRole("switch", { name: "Public board", exact: true }).click()
    await expect(panel.getByRole("group", { name: "Confirm public board change" })).toContainText("discussion")
    // An admitted profile change during staging must abort the captured source,
    // then a fresh owner confirmation may publish the current snapshot.
    let injectedSourceChange: { before: string[]; after: string[] } | undefined
    let fileUploads = 0
    let injectionStarted = false
    let presentationRefresh: { before: string[]; after: string[]; beforeVersion: number; afterVersion: number } | undefined
    await page.route(`${origin}/v1/public/boards/${fixture.boardId}/files`, async route => {
      if (route.request().method() === "PUT") fileUploads++
      if (!injectionStarted && route.request().method() === "PUT") {
        injectionStarted = true
        injectedSourceChange = await page.evaluate(async () => {
          const app = (await import("/src/test/stateFixture.ts")).useTincanban()
          const { workspaceHeads } = await import("/src/crdt.ts")
          const before = workspaceHeads(app.getActiveDoc()!)
          await app.executeCommandAsync({ kind: "setMemberAvatar", avatarData: null, changedAt: new Date().toISOString() })
          return { before, after: workspaceHeads(app.getActiveDoc()!) }
        })
      } else if (route.request().method() === "PUT" && !presentationRefresh) {
        presentationRefresh = await page.evaluate(async () => {
          const app = (await import("/src/test/stateFixture.ts")).useTincanban()
          const { workspaceHeads } = await import("/src/crdt.ts")
          const before = workspaceHeads(app.getActiveDoc()!), beforeVersion = app.docVersion.value
          await app.refreshIdentity()
          return { before, after: workspaceHeads(app.getActiveDoc()!), beforeVersion, afterVersion: app.docVersion.value }
        })
      }
      await route.continue()
    })
    await panel.getByRole("button", { name: "Enable public access", exact: true }).click()
    const revision = async () => await panel.getAttribute("data-public-revision")
    const sourceChangedMessage = "Board source changed during publication preparation"
    let injectedGuardAborted = false
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect.poll(async () => {
        if (await revision() === "1") return "published"
        return await panel.getByRole("alert").count() ? "failed" : "pending"
      }, { timeout: 30_000 }).not.toBe("pending")
      if (await revision() === "1") break
      const errors = await panel.getByRole("alert").allTextContents()
      if (presentationRefresh) throw new Error(`Identity presentation refresh invalidated an unchanged board snapshot: ${errors.join(" | ")}`)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors.every(error => error === sourceChangedMessage)).toBe(true)
      if (injectedSourceChange && !injectedGuardAborted) {
        expect(injectedSourceChange.after).not.toEqual(injectedSourceChange.before)
        expect(await revision()).toBe("0")
        expect((await page.request.get(`${origin}/v1/public/boards/${fixture.boardId}`)).status()).toBe(404)
        injectedGuardAborted = true
      }
      if (attempt === 2) throw new Error("Board source kept changing across three confirmed publication attempts")
      const retry = panel.getByRole("button", { name: "Retry", exact: true })
      if (await retry.isVisible()) await retry.click()
      if (await revision() === "1") break
      await expect(publicSwitch).toBeEnabled()
      await expect(publicSwitch).not.toBeChecked()
      await expect(panel.getByRole("status")).toHaveText("Private · Access requires an invitation.")
      await publicSwitch.click()
      await expect(panel.getByRole("group", { name: "Confirm public board change" })).toContainText("discussion")
      await panel.getByRole("button", { name: "Enable public access", exact: true }).click()
    }
    expect(injectedGuardAborted).toBe(true)
    expect(presentationRefresh).toBeDefined()
    expect(presentationRefresh!.afterVersion).toBeGreaterThan(presentationRefresh!.beforeVersion)
    expect(presentationRefresh!.after).toEqual(presentationRefresh!.before)
    await expect.poll(revision, { timeout: 30_000 }).toBe("1")
    await expect(panel).toContainText("Changes sync automatically.")
    const publicHref = await panel.getByRole("link", { name: "Open public board" }).getAttribute("href")
    expect(publicHref).toContain(`/boards/${fixture.boardId}`)
    expect(new URL(publicHref!, baseURL).searchParams.get("rusty")).toBe(origin)
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
    if (info.project.name === "chromium") await verifyPublicOwnerPollingDraft(page, origin, fixture.boardId, info)

    anonymousContext = await browser.newContext({ acceptDownloads: true })
    const reader = await anonymousContext.newPage()
    const publicRead = reader.waitForResponse(response => response.url() === `${origin}/v1/public/boards/${fixture.boardId}` && response.request().method() === "GET")
    await reader.goto(new URL(publicHref!, baseURL).toString())
    const publicResponse = await publicRead
    const publicResponseBody = await publicResponse.text()
    expect(publicResponse.status()).toBe(200)
    expect(publicResponseBody).not.toMatch(/currentSourceHeads|sourceHeadsHash|deliveryPolicyHash|deliveryPolicyContentHash|deliveryGeneration/u)
    await expect(reader.getByRole("heading", { name: "Public release fixture" })).toBeVisible()
    await expect(reader.getByRole("button", { name: "Open Public release card" })).toBeVisible()
    await reader.getByRole("button", { name: "Open Public release card" }).click()
    const publicCard = reader.getByRole("dialog", { name: "Item overview", exact: true })
    await expect(publicCard.getByText("First published description", { exact: true })).toBeVisible()
    await publicCard.getByRole("button", { name: "Dismiss", exact: true }).click()
    await reader.getByRole("button", { name: /Open discussion for Public release card/ }).click()
    const publicDiscussion = reader.getByRole("dialog", { name: "Discussion", exact: true })
    await expect(publicDiscussion.getByText("Public release discussion", { exact: true })).toBeVisible()
    await publicDiscussion.getByRole("button", { name: "Close", exact: true }).click()
    const anonymousState = await reader.evaluate(async () => ({ profile: localStorage.getItem("tincanban.local_profile.v1"), dbs: await indexedDB.databases() }))
    expect(anonymousState).toEqual({ profile: null, dbs: [] })
    await reader.getByRole("button", { name: "Open Public release card" }).click()
    const publicCardWithFile = reader.getByRole("dialog", { name: "Item overview", exact: true })
    const publicFileLink = publicCardWithFile.getByRole("link", { name: /Release handout/ })
    const firstFileUrl = await publicFileLink.getAttribute("href")
    const downloadStarted = reader.waitForEvent("download")
    await publicFileLink.click()
    const download = await downloadStarted
    expect(download.suggestedFilename()).toBe("release.bin")
    expect(await readFile(await download.path()!)).toEqual(Buffer.from([0, 1, 2, 0xff, 0x41]))

    await publicCardWithFile.getByRole("button", { name: "Dismiss", exact: true }).click()
    const uploadsBeforeTextEdit = fileUploads
    await page.getByRole("button", { name: "Open Public release card" }).click()
    const editDetail = page.getByRole("dialog", { name: "Item overview" })
    await editDetail.getByRole("button", { name: "Edit" }).click()
    const editor = page.getByRole("dialog", { name: "Edit item" })
    await editor.getByLabel("Body").fill("Second published description")
    await editor.getByRole("button", { name: "Save changes" }).click()
    if (await editDetail.count()) await editDetail.getByRole("button", { name: "Close detail" }).click()
    try {
      await expect(reader.getByText("Second published description", { exact: true })).toBeVisible({ timeout: 30_000 })
      expect(fileUploads, "An ordinary text edit reuses Rusty's existing attachment bytes").toBe(uploadsBeforeTextEdit)
    } catch (cause) {
      const ownerPublication = await openPublication()
      console.error("Owner publication after stalled update:", await ownerPublication.innerText())
      throw cause
    }
    await page.setViewportSize({ width: 390, height: 844 })
    panel = await openPublication()
    await expect(panel).toHaveAttribute("data-public-revision", "2", { timeout: 30_000 })
    const missingAttachment = await page.evaluate(async () => {
      const state = (await import("/src/test/stateFixture.ts")).useTincanban()
      const document = state.getActiveDoc()!
      const entity = Object.values(document.entities).find(item => item.title === "Release handout") as { file: import("/src/domain/model.ts").FileReference }
      const attachments = await import("/src/attachments.ts")
      const descriptor = attachments.blobDescriptor(entity.file)!
      const bytes = await attachments.readStoredAttachment(descriptor)
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("tincanban-attachments-v1")
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction("blobs", "readwrite")
          const store = transaction.objectStore("blobs")
          const keys = store.getAllKeys()
          keys.onsuccess = () => {
            for (const key of keys.result) {
              if (key === descriptor.blobId || key === `mesh-blob-stream-v1:${descriptor.blobId}` ||
                typeof key === "string" && key.startsWith(`mesh-blob-chunk-v1:${descriptor.blobId}:`)) store.delete(key)
            }
          }
          transaction.oncomplete = () => { db.close(); resolve() }
          transaction.onerror = () => { db.close(); reject(transaction.error) }
        }
      })
      attachments.configureAttachmentFetcher(async () => undefined)
      return { file: entity.file, bytes: Array.from(bytes!), missingLocally: await attachments.readStoredAttachment(descriptor) === undefined }
    })
    expect(missingAttachment.missingLocally).toBe(true)
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
    await page.evaluate(async () => {
      const app = (await import("/src/test/stateFixture.ts")).useTincanban()
      const item = Object.values(app.getActiveDoc()!.entities).find(entity => entity.title === "Public release card") as { id: string }
      await app.executeCommandAsync({ kind: "patchItem", entityId: item.id, body: "Attachment recovery pending" })
    })
    await page.waitForTimeout(250)
    panel = await openPublication()
    await expect(panel.getByRole("alert")).toContainText("unavailable", { timeout: 30_000 })
    const bounds = await panel.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
    await reader.reload()
    await expect(reader.getByText("Second published description")).toBeVisible()
    expect(await reader.evaluate(async href => (await fetch(href!, { cache: "no-store" })).status, firstFileUrl)).toBe(200)
    await page.evaluate(async ({ file, bytes }) => {
      const attachments = await import("/src/attachments.ts")
      await attachments.writeStoredAttachment(attachments.blobDescriptor(file)!, Uint8Array.from(bytes))
    }, missingAttachment)
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
    await page.evaluate(async () => {
      const app = (await import("/src/test/stateFixture.ts")).useTincanban()
      const item = Object.values(app.getActiveDoc()!.entities).find(entity => entity.title === "Public release card") as { id: string }
      await app.executeCommandAsync({ kind: "patchItem", entityId: item.id, body: "Third published description" })
    })
    await expect(reader.getByText("Third published description", { exact: true })).toBeVisible({ timeout: 30_000 })
    panel = await openPublication()
    await expect(panel).toHaveAttribute("data-public-revision", "3", { timeout: 30_000 })
    // A refreshed board keeps an earlier file URL usable while that exact file
    // remains in the active manifest. Withdrawal below must still revoke it.
    expect(await reader.evaluate(async href => (await fetch(href!, { cache: "no-store" })).status, firstFileUrl)).toBe(200)

    await stop()
    await start()
    await reader.reload()
    await expect(reader.getByRole("button", { name: "Open Public release card" })).toBeVisible({ timeout: 30_000 })
    await expect(reader.getByText("Third published description")).toBeVisible()
    await reader.getByRole("button", { name: "Open Public release card" }).click()
    const updatedCard = reader.getByRole("dialog", { name: "Item overview", exact: true })
    const updatedFile = updatedCard.getByRole("link", { name: /Release handout/ })
    const updatedDownloadStarted = reader.waitForEvent("download")
    await updatedFile.click()
    expect(await readFile(await (await updatedDownloadStarted).path()!)).toEqual(Buffer.from([0, 1, 2, 0xff, 0x41]))
    const updatedFileUrl = await updatedFile.getAttribute("href")

    await panel.getByRole("switch", { name: "Public board", exact: true }).click()
    // Discovery can reconnect after Rusty restarts. Keep controls pending until
    // the exact withdrawal is acknowledged, rather than timing its network work as a UI interaction.
    const withdrawal = page.waitForResponse(response => response.url() === `${origin}/v1/public/boards/${fixture.boardId}` &&
      response.request().method() === "PUT" && response.request().postDataJSON().action === "unpublish", { timeout: 30_000 })
    await panel.getByRole("button", { name: "Disable public access", exact: true }).click()
    expect((await withdrawal).status()).toBe(200)
    await expect(panel.getByRole("switch", { name: "Public board", exact: true })).toBeEnabled()
    await expect(panel.getByRole("switch", { name: "Public board", exact: true })).not.toBeChecked()
    await reader.reload()
    await expect(reader.getByRole("heading", { name: "Board unavailable" })).toBeVisible()
    const withdrawnFile = await reader.evaluate(async href => (await fetch(href!, { cache: "no-store" })).status, updatedFileUrl)
    expect(withdrawnFile).toBe(404)
  } finally {
    if (anonymousContext && !anonymousContext.pages().every(contextPage => contextPage.isClosed())) await anonymousContext.close()
    if (child && child.exitCode === null) await stop()
    await rm(directory, { recursive: true, force: true })
  }
})
