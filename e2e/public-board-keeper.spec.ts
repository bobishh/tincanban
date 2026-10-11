import { expect, test } from "@playwright/test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { discussObject } from "./support/discussions"

test("Given an owner publishes a board, when Keeper restarts and the owner withdraws it, then anonymous readers get only the active snapshot and file bytes", async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000)
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title", { exact: true }).fill("Public release fixture")
  await create.getByRole("radio", { name: "Blank board" }).check()
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
    const state = (await import("/src/state.ts")).useTincanban()
    const chat = await (await import("/src/chat/service.ts")).loadChat(state.activeWorkspace.id)
    return { workspaceId: state.activeWorkspace.id, chat: chat.messages.map(message => ({ body: message.body, context: message.context })) }
  })
  expect(storedDiscussion.chat.some(message => message.body === "Public release discussion")).toBe(true)
  await discussion.getByRole("button", { name: "Close", exact: true }).click()
  if (await cardDetail.count()) await cardDetail.getByRole("button", { name: "Close detail" }).click()

  const fixture = await page.evaluate(async () => {
    const state = (await import("/src/state.ts")).useTincanban()
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
  try {
    await start()
    await page.getByRole("button", { name: "Publish board" }).click()
    const panel = page.getByRole("region", { name: "Public board publication" })
    await panel.getByRole("button", { name: "Check publication" }).click()
    await expect(panel).toContainText("This board is not public.")
    page.on("dialog", dialog => dialog.accept())
    await panel.getByRole("button", { name: "Publish", exact: true }).click()
    await expect(panel).toContainText("Public revision 1", { timeout: 30_000 })
    const publicHref = await panel.getByRole("link", { name: "Open public board" }).getAttribute("href")
    expect(publicHref).toContain(`/boards/${fixture.boardId}`)

    anonymousContext = await browser.newContext({ acceptDownloads: true })
    const reader = await anonymousContext.newPage()
    await reader.goto(new URL(publicHref!, baseURL).toString())
    await expect(reader.getByRole("heading", { name: "Public release fixture" })).toBeVisible()
    await expect(reader.getByRole("heading", { name: "Public release card" })).toBeVisible()
    await reader.getByRole("button", { name: "Read card" }).click()
    const publicCard = reader.getByRole("dialog", { name: "Public release card" })
    await expect(publicCard.getByText("Public release discussion", { exact: true })).toBeVisible()
    await publicCard.getByRole("button", { name: "Close" }).click()
    const anonymousState = await reader.evaluate(async () => ({ profile: localStorage.getItem("tincanban.local_profile.v1"), dbs: await indexedDB.databases() }))
    expect(anonymousState).toEqual({ profile: null, dbs: [] })
    const publicFileLink = reader.getByRole("link", { name: /Release handout/ })
    const firstFileUrl = await publicFileLink.getAttribute("href")
    const downloadStarted = reader.waitForEvent("download")
    await publicFileLink.click()
    const download = await downloadStarted
    expect(download.suggestedFilename()).toBe("release.bin")
    expect(await readFile(await download.path()!)).toEqual(Buffer.from([0, 1, 2, 0xff, 0x41]))

    await page.getByRole("button", { name: "Open Public release card" }).click()
    const editDetail = page.getByRole("dialog", { name: "Item overview" })
    await editDetail.getByRole("button", { name: "Edit" }).click()
    const editor = page.getByRole("dialog", { name: "Edit item" })
    await editor.getByLabel("Body").fill("Second published description")
    await editor.getByRole("button", { name: "Save changes" }).click()
    if (await editDetail.count()) await editDetail.getByRole("button", { name: "Close detail" }).click()
    await page.waitForTimeout(150)
    await panel.getByRole("button", { name: "Check publication" }).click()
    await expect(panel).toContainText("Public revision 1")
    await panel.getByRole("button", { name: "Check for local changes" }).click()
    await expect(panel).toContainText("Local content has unpublished changes")
    const missingAttachment = await page.evaluate(async () => {
      const state = (await import("/src/state.ts")).useTincanban()
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
          transaction.objectStore("blobs").delete(descriptor.blobId)
          transaction.oncomplete = () => { db.close(); resolve() }
          transaction.onerror = () => { db.close(); reject(transaction.error) }
        }
      })
      attachments.configureAttachmentFetcher(async () => undefined)
      return { file: entity.file, bytes: Array.from(bytes!), missingLocally: await attachments.readStoredAttachment(descriptor) === undefined }
    })
    expect(missingAttachment.missingLocally).toBe(true)
    await panel.getByRole("button", { name: "Refresh" }).click()
    await panel.getByRole("button", { name: "Check for local changes" }).click()
    await expect(panel.getByRole("alert")).toContainText("unavailable", { timeout: 30_000 })
    await panel.getByRole("button", { name: "Update", exact: true }).click()
    await expect(panel.getByRole("alert")).toContainText("unavailable", { timeout: 30_000 })
    await reader.reload()
    await expect(reader.getByText("First published description")).toBeVisible()
    expect(await reader.evaluate(async href => (await fetch(href!, { cache: "no-store" })).status, firstFileUrl)).toBe(200)
    await page.evaluate(async ({ file, bytes }) => {
      const attachments = await import("/src/attachments.ts")
      await attachments.writeStoredAttachment(attachments.blobDescriptor(file)!, Uint8Array.from(bytes))
    }, missingAttachment)
    await panel.getByRole("button", { name: "Refresh" }).click()
    await expect(panel).toContainText("Public revision 1")
    await panel.getByRole("button", { name: "Check for local changes" }).click()
    await expect(panel).toContainText("Local content has unpublished changes")
    await panel.getByRole("button", { name: "Update", exact: true }).click()
    await expect(panel).toContainText("Public revision 2", { timeout: 30_000 })
    expect(await reader.evaluate(async href => (await fetch(href!, { cache: "no-store" })).status, firstFileUrl)).toBe(404)

    await stop()
    await start()
    await reader.reload()
    await expect(reader.getByText("Second published description")).toBeVisible()
    const updatedFile = reader.getByRole("link", { name: /Release handout/ })
    const updatedDownloadStarted = reader.waitForEvent("download")
    await updatedFile.click()
    expect(await readFile(await (await updatedDownloadStarted).path()!)).toEqual(Buffer.from([0, 1, 2, 0xff, 0x41]))
    const updatedFileUrl = await updatedFile.getAttribute("href")

    await panel.getByRole("button", { name: "Unpublish", exact: true }).click()
    await expect(panel).toContainText("This board is not public.")
    await reader.reload()
    await expect(reader.getByRole("heading", { name: "Board unavailable" })).toBeVisible()
    const withdrawnFile = await reader.evaluate(async href => (await fetch(href!, { cache: "no-store" })).status, updatedFileUrl)
    expect(withdrawnFile).toBe(404)
  } finally {
    if (anonymousContext) await anonymousContext.close()
    if (child && child.exitCode === null) await stop()
    await rm(directory, { recursive: true, force: true })
  }
})
