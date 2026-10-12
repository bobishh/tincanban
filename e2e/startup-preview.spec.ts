import { expect, test, type Locator } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

async function expectSequentialDots(status: Locator) {
  const indicator = status.locator(".startup-status-mark")
  await expect(indicator.locator(".startup-status-dot")).toHaveCount(3)
  const frames = await indicator.evaluate(async element => {
    const dots = [...element.querySelectorAll<HTMLElement>(".startup-status-dot")]
    const animations = dots.flatMap(dot => dot.getAnimations())
    const paint = [element, ...dots].map(mark => {
      const style = getComputedStyle(mark)
      return { border: style.borderTopWidth, artwork: style.borderImageSource, transform: style.transform }
    })
    const movingProperties = animations.map(animation => Object.keys((animation.effect as KeyframeEffect).getKeyframes()[0]!).filter(key => !["offset", "computedOffset", "easing", "composite"].includes(key)))
    const frames = []
    for (const progress of [.125, .375, .625, .875]) {
      for (const animation of animations) {
        animation.pause()
        animation.currentTime = Number(animation.effect!.getTiming().duration) * progress
      }
      await new Promise(requestAnimationFrame)
      frames.push(dots.map(dot => Number(getComputedStyle(dot).opacity)))
    }
    for (const animation of animations) animation.play()
    return { paint, movingProperties, frames }
  })
  expect(frames.paint).toEqual(Array.from({ length: 4 }, () => ({ border: "0px", artwork: "none", transform: "none" })))
  expect(frames.movingProperties).toEqual([["opacity"], ["opacity"], ["opacity"]])
  expect(frames.frames).toEqual([[1, 0, 0], [1, 1, 0], [1, 1, 1], [0, 0, 0]])
}

test("Given startup HTML before Vue loads, When page styles arrive, Then the same three dots appear sequentially without a rotating ink frame", async ({ page }) => {
  let finishLoading!: () => void
  const loading = new Promise<void>(resolve => { finishLoading = resolve })
  await page.route("**/src/App.vue", async route => { await loading; await route.continue() })
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" })
    // Hold Vue back while the shared ink styles reach the HTML placeholder.
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).borderImageSource)).toContain("ink-frame")
    const status = page.locator(".boot-placeholder")
    await expect(status).toBeVisible()
    await expectSequentialDots(status)
    await page.emulateMedia({ reducedMotion: "reduce" })
    const dots = status.locator(".startup-status-dot")
    expect(await dots.evaluateAll(elements => elements.map(element => ({ opacity: getComputedStyle(element).opacity, animations: element.getAnimations().length })))).toEqual(Array.from({ length: 3 }, () => ({ opacity: "1", animations: 0 })))
  } finally {
    finishLoading()
    await page.unrouteAll({ behavior: "wait" })
  }
})

for (const width of [390, 1440]) for (const fail of [false, true]) test(`Given a saved board at ${width}px, When history checks ${fail ? "fail" : "are pending"}, Then a full loader reveals saved cards before compact checks and edits wait for confirmed access`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 })
  await page.goto("/")
  await createJobSearchWorkspace(page, "Saved board")
  await page.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
    const A = await import("/@id/@automerge/automerge/slim")
    const storage = (await import("/src/storage.ts")).defaultStorage
    const column = app.genericColumns.value.find(column => column.title === "Lead")!
    await app.executeCommandAsync({ kind: "createItem", id: "saved-preview-card", parentId: column.id, title: "Saved engineer" })
    const saved = app.getActiveDoc()!
    const raw = A.change(A.clone(saved), draft => { draft.entities["saved-preview-card"].title = "Unverified replacement" })
    await storage.commitWorkspace(saved.id, saved, A.save(saved), [], undefined, { bytes: A.save(raw), decisions: [] })
    A.free(raw)
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
  await expectSequentialDots(status)
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
  await expectSequentialDots(status)
  await expect(page.locator(".boot-placeholder")).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Add lead to/ })).toHaveCount(0)
  await expect(page.locator('.brand [data-role-stamp="visitor"]')).toHaveCount(0)
  const strip = await status.boundingBox()
  await expect(status).not.toHaveClass(/startup-screen/)
  await expect(status).toHaveCSS("position", "fixed")
  await expect(status).toBeInViewport()
  await expect(page.locator(".startup-status-slot")).toHaveCount(0)
  expect(strip!.y).toBeGreaterThan(700)
  expect(strip!.height).toBeLessThan(64)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Saved engineer")
  await expect(card).toBeVisible()
  await card.click()
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeDisabled()
  await page.getByRole("button", { name: "Close detail" }).click()
  await page.screenshot({ path: info.outputPath(`preview-${width}.png`) })
  const boardPosition = await page.locator(".board").boundingBox()
  const pendingToolbar = await page.locator(".toolbar").boundingBox()
  await page.evaluate(() => window.dispatchEvent(new Event("tincanban:finish-history-check")))
  if (fail) {
    await expect(page.getByRole("alert", { name: "Board status" })).toContainText("Saved board is view only")
    await expect(page.getByRole("alert", { name: "Board status" })).toHaveCSS("position", "fixed")
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
