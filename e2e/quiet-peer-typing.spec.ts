import { writeFile } from "node:fs/promises"
import { expect, test } from "./support/coverage"
import { populatedBoard } from "./support/detailedBoard"

test.use({ trace: "off" })

test("Given a committed peer snapshot and an unsaved card, when duplicate preflight and merge run during Body typing, then history is not replayed and input stays responsive", async ({ page }, info) => {
  test.setTimeout(120_000)
  await populatedBoard(page)
  await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    const { exportAuthorizationBundle } = await import("/src/sync/changeAuthorization.ts")
    const bytes = await app.readWorkspaceBytes(app.activeWorkspace.id)
    const authorization = await exportAuthorizationBundle(bytes, app.getCurrentProfile()!)
    await app.mergeAuthorizedWorkspace(app.activeWorkspace.id, bytes, authorization)
    Object.assign(window, { quietPacket: { id: app.activeWorkspace.id, bytes, authorization } })
  })
  await page.getByRole("button", { name: "Add item to To do", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Item details", exact: true })
  const body = form.getByLabel("Body", { exact: true })
  await body.focus()
  const session = await page.context().newCDPSession(page)
  await session.send("Emulation.setCPUThrottlingRate", { rate: 4 })
  await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    const { clearMeshTrace } = await import("/src/sync/meshTrace.ts")
    clearMeshTrace()
    const state = { stopped: false, repeats: 0, errors: [] as string[], paints: [] as number[], events: [] as number[],
      version: app.docVersion.value, finished: Promise.resolve() }
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries() as PerformanceEventTiming[]) {
        if (entry.interactionId && ["keydown", "keyup"].includes(entry.name)) state.events.push(entry.duration)
      }
    })
    observer.observe({ type: "event", durationThreshold: 16 })
    document.querySelector('[role="dialog"][aria-label="Item details"]')!.addEventListener("input", () => {
      const started = performance.now()
      requestAnimationFrame(() => requestAnimationFrame(() => state.paints.push(performance.now() - started)))
    })
    const packet = (window as unknown as { quietPacket: { id: string; bytes: Uint8Array; authorization: unknown } }).quietPacket
    state.finished = (async () => {
      while (!state.stopped) {
        try {
          await app.validateAuthorizedWorkspace(packet.id, packet.bytes.slice(), structuredClone(packet.authorization))
          await app.mergeAuthorizedWorkspace(packet.id, packet.bytes.slice(), structuredClone(packet.authorization))
          state.repeats++
        } catch (cause) { state.errors.push(String(cause)); break }
        await new Promise(resolve => setTimeout(resolve, 40))
      }
    })()
    Object.assign(window, { quietReceive: state, quietObserver: observer })
  })
  const text = "Draft stays responsive while identical peer packets arrive."
  await body.pressSequentially(text, { delay: 25 })
  await expect(body).toHaveValue(text)
  const measured = await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    const { meshTraceSnapshot } = await import("/src/sync/meshTrace.ts")
    const state = (window as unknown as { quietReceive: { stopped: boolean; repeats: number; errors: string[]; paints: number[]; events: number[]; version: number; finished: Promise<void> } }).quietReceive
    state.stopped = true
    await state.finished
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    ;(window as unknown as { quietObserver: PerformanceObserver }).quietObserver.disconnect()
    return { repeats: state.repeats, errors: state.errors, paints: state.paints, events: state.events,
      unchangedVersion: state.version === app.docVersion.value,
      admissionRuns: meshTraceSnapshot().filter(event => event.event === "workspace.admission.started").length }
  })
  await session.send("Emulation.setCPUThrottlingRate", { rate: 1 })
  await writeFile(info.outputPath("quiet-peer-measurement.json"), JSON.stringify(measured, null, 2))
  expect(measured.errors).toEqual([])
  expect(measured.repeats).toBeGreaterThan(5)
  expect(measured.admissionRuns).toBe(0)
  expect(measured.unchangedVersion).toBe(true)
  expect(measured.paints).toHaveLength(text.length)
  expect(Math.max(...measured.paints)).toBeLessThan(200)
  expect(Math.max(0, ...measured.events)).toBeLessThan(200)

  const rejected = await page.evaluate(async () => {
    const app = (await import("/src/test/stateFixture.ts")).useTincanban()
    const packet = (window as unknown as { quietPacket: { id: string; bytes: Uint8Array; authorization: { records: Array<{ signed: { signature: string } }> } } }).quietPacket
    const altered = structuredClone(packet.authorization)
    altered.records[0]!.signed.signature += "forged"
    try { await app.validateAuthorizedWorkspace(packet.id, packet.bytes, altered); return false }
    catch {
      await app.validateAuthorizedWorkspace(packet.id, packet.bytes, packet.authorization)
      return true
    }
  })
  expect(rejected).toBe(true)
  await expect(body).toHaveValue(text)
  await expect(form).toBeVisible()
  await page.screenshot({ path: info.outputPath("quiet-peer-unsaved-body.png") })
})
