import { expect, type Page, type Response, type TestInfo } from "@playwright/test"
import { writeFile } from "node:fs/promises"

/** Exercise a real owner status poll while its unsaved Body draft receives keyboard input. */
export async function verifyPublicOwnerPollingDraft(page: Page, origin: string, boardId: string, info: TestInfo) {
  const isOwnerPoll = (response: Response) => response.url() === `${origin}/v1/public/challenges` &&
    response.ok() && response.request().postDataJSON()?.boardId === boardId
  // Warm the first comparison after publication; measure the following unchanged status poll.
  await page.waitForResponse(isOwnerPoll, { timeout: 20_000 })
  await page.waitForTimeout(1_000)
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  const body = form.getByLabel("Body", { exact: true })
  await expect(body).toBeVisible()
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  const initialVersion = await page.evaluate(async () => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
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
      return { ...measure, version: state.docVersion.value }
    } } })
    return state.docVersion.value
  })
  let polls = 0
  const onResponse = (response: Response) => { if (isOwnerPoll(response)) polls++ }
  page.on("response", onResponse)
  try {
    const draft = "draft body ".repeat(8)
    await body.pressSequentially(draft, { delay: 200, timeout: 30_000 })
    await expect(body).toHaveValue(draft)
    await expect.poll(() => polls, { timeout: 5_000 }).toBeGreaterThan(0)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const measured = await page.evaluate(() => (window as unknown as {
      publicPollingMeasurement: { finish: () => { paints: number[]; events: number[]; policySignatures: number; attachmentReads: number; version: number } }
    }).publicPollingMeasurement.finish())
    const measurementPath = info.outputPath("public-owner-polling.json")
    await writeFile(measurementPath, JSON.stringify({ ...measured, polls }, null, 2))
    await info.attach("public-owner-polling.json", { path: measurementPath, contentType: "application/json" })
    expect(measured.policySignatures).toBe(0)
    expect(measured.attachmentReads).toBe(0)
    expect(measured.version).toBe(initialVersion)
    expect(measured.paints).toHaveLength(draft.length)
    expect(Math.max(...measured.paints)).toBeLessThan(200)
    expect(Math.max(0, ...measured.events)).toBeLessThan(200)
  } finally {
    page.off("response", onResponse)
    await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
    if (await form.isVisible()) await form.getByRole("button", { name: "Cancel", exact: true }).click()
  }
}
