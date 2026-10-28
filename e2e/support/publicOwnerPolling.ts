import { expect, type Page, type Request, type Response, type TestInfo } from "@playwright/test"
import { writeFile } from "node:fs/promises"

/** Exercise a real owner status poll while the unsaved card form receives keyboard input. */
export async function verifyPublicOwnerPollingDraft(page: Page, origin: string, boardId: string, info: TestInfo) {
  const isOwnerChallenge = (response: Response) => response.url() === `${origin}/v1/public/challenges` &&
    response.ok() && response.request().postDataJSON()?.boardId === boardId
  const isOwnerStatusRead = (response: Response) => response.url() === `${origin}/v1/public/boards/${encodeURIComponent(boardId)}` &&
    response.request().method() === "GET" && response.ok()
  if (await page.getByRole("button", { name: "Menu", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Menu", exact: true }).click()
    await page.getByRole("dialog").getByRole("button", { name: "Settings", exact: true }).click()
  } else await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings", exact: true })
  const ownerStatusRead = page.waitForResponse(isOwnerStatusRead, { timeout: 20_000 })
  await settings.getByRole("tab", { name: "Workspace", exact: true }).click()
  const accessPanel = settings.getByRole("region", { name: "Public board access", exact: true })
  // Challenge issuance starts the owner status read; the board response completes it.
  await ownerStatusRead
  const settledPublicStatus = "Public · Changes sync automatically."
  await expect(accessPanel.getByRole("status")).toHaveText(settledPublicStatus, { timeout: 20_000 })
  // The status read queues a debounced comparison. Require the visible controls to
  // remain idle longer than that debounce so it cannot overlap the draft measurement.
  await page.waitForFunction(({ selector, quietMs, expectedStatus }) => {
    const panel = document.querySelector(selector)
    if (!panel) return false
    return new Promise<boolean>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = () => panel.getAttribute("aria-busy") === "false" && panel.getAttribute("data-public-sync-pending") === "false" &&
        panel.querySelector('[role="status"]')?.textContent?.trim() === expectedStatus
      const observer = new MutationObserver(() => arm())
      const finish = () => {
        if (timer) clearTimeout(timer)
        observer.disconnect()
        resolve(idle())
      }
      const arm = () => {
        if (timer) clearTimeout(timer)
        timer = undefined
        if (idle()) timer = setTimeout(finish, quietMs)
      }
      observer.observe(panel, { attributes: true, childList: true, characterData: true, subtree: true })
      arm()
    })
  }, { selector: '[aria-label="Public board access"]', quietMs: 400, expectedStatus: settledPublicStatus }, { timeout: 20_000 })
  await expect(accessPanel).toHaveAttribute("data-public-sync-pending", "false", { timeout: 20_000 })
  await settings.getByRole("button", { name: "Dismiss", exact: true }).click()
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  const body = form.getByLabel("Body", { exact: true })
  await expect(body).toBeVisible()
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  const initial = await page.evaluate(async () => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    const { workspaceHeads } = await import("/src/crdt.ts")
    const measure = { paints: [] as number[], events: [] as number[], policySignatures: 0, attachmentReads: 0 }
    const get = IDBObjectStore.prototype.get
    IDBObjectStore.prototype.get = function(key) {
      if (this.transaction.db.name === "tincanban-attachments-v1" && this.name === "blobs") measure.attachmentReads++
      return get.call(this, key)
    }
    const sign = crypto.subtle.sign.bind(crypto.subtle)
    crypto.subtle.sign = ((...args: Parameters<SubtleCrypto["sign"]>) => {
      if (new TextDecoder().decode(args[2]).includes('"kind":"rusty-public-board-delivery-policy"')) measure.policySignatures++
      return sign(...args)
    }) as SubtleCrypto["sign"]
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        if (entry.interactionId && ["keydown", "keyup"].includes(entry.name)) measure.events.push(entry.duration)
      }
    })
    observer.observe({ type: "event", durationThreshold: 16 })
    const input = document.querySelector('[role="dialog"][aria-label="Item details"] textarea')!
    const onInput = () => {
      const start = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => measure.paints.push(performance.now() - start)))
    }
    input.addEventListener("input", onInput)
    Object.assign(window, { publicPollingMeasurement: { measure, finish: () => {
      measure.events.push(...(observer.takeRecords() as PerformanceEventTiming[]).filter(entry => entry.interactionId).map(entry => entry.duration))
      observer.disconnect(); crypto.subtle.sign = sign; IDBObjectStore.prototype.get = get; input.removeEventListener("input", onInput)
      return { ...measure, version: state.docVersion.value, heads: workspaceHeads(state.getActiveDoc()!), document: JSON.stringify(state.getActiveDoc()) }
    } } })
    return { version: state.docVersion.value, heads: workspaceHeads(state.getActiveDoc()!), document: JSON.stringify(state.getActiveDoc()) }
  })
  let polls = 0
  const publicWrites: string[] = []
  const onResponse = (response: Response) => { if (isOwnerChallenge(response)) polls++ }
  const onRequest = (request: Request) => {
    if (request.method() === "PUT" && request.url().startsWith(`${origin}/v1/public/boards/${encodeURIComponent(boardId)}`)) publicWrites.push(request.url())
  }
  page.on("response", onResponse)
  page.on("request", onRequest)
  try {
    const draft = "draft body ".repeat(8)
    await body.pressSequentially(draft, { delay: 200, timeout: 30_000 })
    await expect(body).toHaveValue(draft)
    await expect.poll(() => polls, { timeout: 5_000 }).toBeGreaterThan(0)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const measured = await page.evaluate(() => (window as unknown as {
      publicPollingMeasurement: { finish: () => { paints: number[]; events: number[]; policySignatures: number; attachmentReads: number; version: number; heads: string[]; document: string } }
    }).publicPollingMeasurement.finish())
    const measurementPath = info.outputPath("public-owner-polling.json")
    await writeFile(measurementPath, JSON.stringify({ ...measured, initialVersion: initial.version, polls, publicWrites }, null, 2))
    await info.attach("public-owner-polling.json", { path: measurementPath, contentType: "application/json" })
    expect(measured.policySignatures).toBe(0)
    expect(measured.attachmentReads).toBe(0)
    // docVersion also invalidates profile presentation. CRDT heads and contents
    // identify saved board changes independently from those harmless refreshes.
    expect(measured.heads).toEqual(initial.heads)
    expect(measured.document).toBe(initial.document)
    expect(publicWrites).toEqual([])
    expect(measured.paints).toHaveLength(draft.length)
    expect(Math.max(...measured.paints)).toBeLessThan(200)
    expect(Math.max(0, ...measured.events)).toBeLessThan(200)
  } finally {
    page.off("response", onResponse)
    page.off("request", onRequest)
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    if (await form.isVisible()) await form.getByRole("button", { name: "Cancel", exact: true }).click()
  }
}
