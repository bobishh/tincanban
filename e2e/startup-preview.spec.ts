import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given a saved admitted board, When a fresh tab reloads unchanged state, Then editing becomes ready without sending history to the admission worker", async ({ page }) => {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Saved admission")
  await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    await app.createItemAsync({ title: "Already admitted — Engineer", parentId: app.genericColumns.value[0].id, values: Object.fromEntries(["company", "role"].map((key, index) => [app.activeBoard.value!.preset!.bindings[`field.${key}`], ["Already admitted", "Engineer"][index]])) })
  })
  await page.addInitScript(() => {
    const OriginalWorker = Worker
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (options?.name !== "workspace-admission") return
        const send = this.postMessage.bind(this)
        this.postMessage = (message, transfer) => {
          if (message.kind !== "access") throw new Error("Unchanged saved history must not be replayed")
          Reflect.apply(send, this, [message, transfer])
        }
      }
    }
  })
  await page.reload()
  await expect(page.locator('.brand [data-role-stamp="owner"]')).toBeVisible()
  await expect(page.getByRole("button", { name: /Add lead to/ }).first()).toBeVisible()
  await expect(page.locator(".board")).toContainText("Already admitted")
  await expect(page.getByRole("alert", { name: "Board status" })).toHaveCount(0)
})

for (const width of [390]) for (const fail of [false, true]) test(`Given a saved board at ${width}px, When history checks ${fail ? "fail" : "are pending"}, Then a full loader reveals saved cards before compact checks and edits wait for confirmed access`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 })
  await page.goto("/")
  await createJobSearchWorkspace(page, "Saved board")
  await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    const A = await import("/@id/@automerge/automerge/slim")
    const storage = (await import("/src/storage.ts")).defaultStorage
    const { executeCommand } = await import("/src/domain/commands.ts")
    const column = app.genericColumns.value.find(column => column.title === "Lead")!
    await app.executeCommandAsync({ kind: "createItem", id: "saved-preview-card", parentId: column.id, title: "Saved engineer" })
    const saved = app.getActiveDoc()!
    const previous = (await storage.loadCausalEvidence(saved.id))!
    const change = await executeCommand(A.clone(saved), { kind: "patchItem", entityId: "saved-preview-card", title: "Unverified replacement" }, app.getCurrentProfile()!)
    if (!change.ok) throw new Error(change.error.message)
    const { receipt: commandReceipt, proof: commandProof, newDoc: candidate } = change.value
    await storage.withWorkspaceTransaction(saved.id, transaction => transaction.commitWorkspace(saved, A.save(saved), [], {
      receipt: commandReceipt, changeBytes: A.getLastLocalChange(candidate)!, proof: commandProof,
    }, {
      bytes: A.save(candidate), authorizationEvidence: previous.authorizationEvidence,
      decisions: [...previous.decisions, { hash: commandReceipt.changeHash, status: { type: "quarantined", reason: "Missing workspace authorization" } }],
    }))
    A.free(candidate)
  })
  await page.addInitScript(({ fail }) => {
    const instantiate = WebAssembly.instantiateStreaming.bind(WebAssembly)
    const runtime = new Promise<void>(resolve => window.addEventListener("tincanban:finish-runtime", () => resolve(), { once: true }))
    WebAssembly.instantiateStreaming = async (source, imports) => { await runtime; return instantiate(source, imports) }
    const OriginalWorker = Worker
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        if (options?.name !== "workspace-admission") return
        const send = this.postMessage.bind(this)
        this.postMessage = (message, transfer) => {
          if (message.kind === "access") { Reflect.apply(send, this, [message, transfer]); return }
          window.addEventListener("tincanban:finish-history-check", () => {
            if (fail) this.dispatchEvent(new MessageEvent("message", { data: { id: message.id, error: "History check failed", fatal: true } }))
            else Reflect.apply(send, this, [message, transfer])
          }, { once: true })
        }
      }
    }
  }, { fail })
  await page.reload({ waitUntil: "domcontentloaded" })
  const card = page.locator('[data-item-id="saved-preview-card"]')
  const status = page.getByRole("status", { name: "Board status" })
  await expect(page.locator(".boot-placeholder")).toHaveCount(0)
  await expect(status).toContainText("Starting local checks")
  await expect(status).toHaveClass(/startup-screen/)
  await expect(page.locator(".toolbar")).not.toBeVisible()
  await expect(card).not.toBeVisible()
  const indicator = status.locator(".startup-status-mark")
  await page.screenshot({ path: info.outputPath(`full-startup-${width}.png`) })
  await page.emulateMedia({ reducedMotion: "reduce" })
  expect(await indicator.evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0)
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await page.evaluate(() => window.dispatchEvent(new Event("tincanban:finish-runtime")))
  await expect(card).toBeVisible()
  await expect(page.locator(".startup-screen")).toHaveCount(0)
  await expect(card).toContainText("Saved engineer")
  await expect(page.getByText("Unverified replacement", { exact: true })).toHaveCount(0)
  await expect(status).toContainText("Checking saved changes")
  await expect(status).toContainText("View only")
  await expect(page.locator(".boot-placeholder")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
  await expect(page.locator('.brand [data-role-stamp="visitor"]')).toHaveCount(0)
  const strip = await status.boundingBox()
  await expect(status).not.toHaveClass(/startup-screen/)
  await expect(status).toBeInViewport()
  await expect(page.locator(".startup-status-slot")).toHaveCount(0)
  expect(strip!.y).toBeGreaterThan(700)
  expect(strip!.height).toBeLessThan(64)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Saved engineer")
  await expect(card).toBeVisible()
  await card.getByRole("button", { name: "Open Saved engineer", exact: true }).click()
  const detail = page.getByRole("dialog", { name: "Item overview", exact: true })
  await expect(detail).toBeVisible()
  await expect(detail.getByRole("button", { name: "Edit", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Close detail" }).click()
  await page.screenshot({ path: info.outputPath(`preview-${width}.png`) })
  const boardPosition = await page.locator(".board").boundingBox()
  const pendingToolbar = await page.locator(".toolbar").boundingBox()
  await page.evaluate(() => window.dispatchEvent(new Event("tincanban:finish-history-check")))
  if (fail) {
    await expect(page.getByRole("alert", { name: "Board status" })).toContainText("Saved board is view only")
    await page.getByRole("alert", { name: "Board status" }).getByText("Details", { exact: true }).click()
    await expect(page.getByRole("alert", { name: "Board status" }).getByText(/History check failed/)).toBeInViewport()
    await expect(page.getByRole("alert", { name: "Board status" }).locator(".startup-status-mark")).toHaveText("!")
    expect(await page.getByRole("alert", { name: "Board status" }).locator(".startup-status-mark").evaluate(element => element.getAnimations({ subtree: true }).length)).toBe(0)
    await expect(card).toBeVisible()
    await expect(page.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
  } else {
    await expect(page.getByRole("button", { name: /Add lead to/ }).first()).toBeVisible()
    await expect(status).toHaveCount(0)
    await expect(page.locator(".startup-status-slot")).toHaveCount(0)
    const settledPosition = await page.locator(".board").boundingBox()
    const settledToolbar = await page.locator(".toolbar").boundingBox()
    const pendingGap = boardPosition!.y - pendingToolbar!.y - pendingToolbar!.height
    const settledGap = settledPosition!.y - settledToolbar!.y - settledToolbar!.height
    expect(Math.abs(settledGap - pendingGap)).toBeLessThan(2)
    await expect(page.locator('.brand [data-role-stamp="owner"]')).toBeVisible()
    await expect(card).toContainText("Saved engineer")
    await expect(page.getByText("Unverified replacement", { exact: true })).toHaveCount(0)
  }
})
