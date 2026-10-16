import { expect, test, type Locator, type Page } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

const latin = "Senior platform engineer supporting dependable product systems and distributed teams"
const cyrillic = "Старший инженер платформы: надёжные продуктовые системы и распределённые команды"
const longText = `${latin}. ${cyrillic}. `.repeat(3)

async function makeLongBoard(page: Page) {
  await page.goto("/")
  await createJobSearchWorkspace(page, "Reading test")
  await page.evaluate(async longText => {
    const { useTincanban } = await import("/src/state.ts")
    const { prepareLocalChangeAuthorizations, exportDocumentAuthorizationBundle } = await import("/src/sync/changeAuthorization.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const app = useTincanban()
    await app.whenReady()
    const base = app.getActiveDoc()!
    const board = Object.values(base.entities).find(entity => entity.kind === "board")!
    const parent = Object.values(base.entities).find(entity => entity.kind === "column" && entity.title === "Lead")!
    const companyId = board.preset!.bindings["field.company"]!
    const roleId = board.preset!.bindings["field.role"]!
    const now = new Date().toISOString()
    const updated = A.change(A.clone(base), draft => {
      for (let index = 0; index < 74; index += 1) {
        const company = `Компания ${index + 1} · Northstar product engineering group`
        const id = `reading-typography-card-${index}`
        draft.entities[id] = { id, title: `${company} — Senior platform engineer ${index + 1}`, body: longText,
          placement: { parentId: parent.id, rank: `${index}/1` }, archivedAt: null, createdAt: now, updatedAt: now,
          lastActivityAt: now, values: { [companyId]: company, [roleId]: `Staff platform engineer ${index + 1} · Старший инженер платформы` } }
      }
    })
    const profile = app.getCurrentProfile()!
    const hashes = A.getChangesMetaSince(updated, A.getHeads(base)).map(change => change.hash)
    const proofs = await prepareLocalChangeAuthorizations(updated, profile, hashes)
    const authorization = await exportDocumentAuthorizationBundle(base, profile)
    await app.mergeAuthorizedWorkspace(updated.id, A.save(updated), { ...authorization, records: [...authorization.records, ...proofs] })
  }, longText)
  await expect(page.locator(".lead-card")).toHaveCount(74)
  await page.getByRole("searchbox", { name: "Search cards" }).fill("Senior platform engineer")
  await expect(page.locator(".card-notes").first()).toBeVisible()
}

async function assertNoHorizontalClipping(page: Page, selector: string) {
  const geometry = await page.locator(selector).evaluateAll(elements => elements.map(element => {
    const node = element as HTMLElement
    return { tag: node.tagName, className: node.className, text: node.innerText.slice(0, 80), width: node.clientWidth, scroll: node.scrollWidth,
      children: [...node.children].map(child => { const element = child as HTMLElement; return { tag: element.tagName, className: element.className, width: element.clientWidth, scroll: element.scrollWidth } }) }
  }))
  expect(geometry.length).toBeGreaterThan(0)
  for (const item of geometry) expect(item.scroll, `Horizontal overflow in ${JSON.stringify(item)}`).toBeLessThanOrEqual(item.width + 1)
}

async function assertNoHiddenVerticalOverflow(page: Page, selector: string) {
  const clipped = await page.locator(selector).evaluateAll(elements => elements.flatMap(element => {
    const node = element as HTMLElement
    const overflowY = getComputedStyle(node).overflowY
    return (overflowY === "hidden" || overflowY === "clip") && node.scrollHeight > node.clientHeight + 1
      ? [{ selector: node.className || node.tagName, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight }]
      : []
  }))
  expect(clipped).toEqual([])
}

async function assertReachable(locator: Locator) {
  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThan(0)
  expect(box!.height).toBeGreaterThan(0)
}

test("Given 74 long bilingual cards, when board is viewed on desktop and mobile, then text and controls stay readable and reachable", async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await makeLongBoard(page)
  await expect(page.locator(".lead-card strong").first()).toHaveCSS("font-family", /Caveat/)
  await expect(page.locator(".company").first()).toHaveCSS("font-family", /Caveat/)
  await expect(page.locator(".card-meta").first()).toHaveCSS("font-family", /Caveat/)
  const filterLabel = page.locator(".filter-label").first()
  if (await filterLabel.count()) await expect(filterLabel).toHaveCSS("font-family", /Caveat/)
  const priority = page.locator(".priority").first()
  if (await priority.count()) await expect(priority).toHaveCSS("font-family", /Caveat/)
  await expect(page.locator(".card-notes").first()).toHaveCSS("font-family", /Caveat/)
  await expect(page.locator(".card-notes").first()).toContainText("Старший инженер платформы")
  await expect(page.locator(".brand-name")).toHaveCSS("font-family", /Caveat/)
  await expect(page.locator(".column-title h2").first()).toHaveCSS("font-family", /Caveat/)
  await assertNoHorizontalClipping(page, ".column, .lead-card, .card-layout")
  await assertNoHiddenVerticalOverflow(page, ".detail-copy, .chat-message-body")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator(".lead-card").first()).toBeVisible()
  await assertNoHorizontalClipping(page, ".column, .lead-card, .card-layout")
  await assertNoHiddenVerticalOverflow(page, ".detail-copy, .chat-message-body")
  await expect(page.locator(".lead-card").nth(73)).toContainText("Компания 74")
})

test("Given long bilingual details, chat and settings, when each surface opens, then prose wraps and remains readable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")
  await page.evaluate(() => { document.documentElement.style.fontSize = "20px" })
  await createJobSearchWorkspace(page, "Reading surfaces")
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  const create = page.getByRole("dialog", { name: /Add item|Item details/ })
  await create.getByLabel("Company *").fill("Northstar")
  await create.getByLabel("Role *").fill("Principal engineer")
  await create.getByPlaceholder("Description or notes...").fill(`${longText.repeat(4)}\n\n## Description heading`)
  await create.getByRole("button", { name: "Create item" }).click()
  const detail = page.getByRole("dialog", { name: "Lead details" })
  await expect(detail.locator(".detail-copy")).toBeVisible()
  await expect(detail.locator(".detail-copy")).toHaveCSS("font-family", /Fira Sans/)
  const detailLineHeight = Number.parseFloat(await detail.locator(".detail-copy").evaluate(element => getComputedStyle(element).lineHeight))
  expect(detailLineHeight).toBeGreaterThanOrEqual(23)
  expect(detailLineHeight).toBeLessThan(24)
  const detailHeading = detail.locator(".detail-head h2")
  await expect(detailHeading).toHaveCSS("font-family", /Caveat/)
  const detailSectionHeading = detail.locator(".detail-copy h2")
  await expect(detailSectionHeading).toHaveCSS("font-family", /Caveat/)
  await assertNoHorizontalClipping(page, ".detail-layout, .detail-primary, .detail-copy")
  await assertNoHiddenVerticalOverflow(page, ".detail-layout, .detail-primary, .detail-copy")
  await detail.getByRole("button", { name: "Close detail" }).click()

  await page.getByRole("button", { name: "Workspace chat" }).click()
  const chat = page.getByRole("dialog", { name: "Workspace chat" })
  await chat.getByRole("textbox", { name: "Message" }).fill(`${longText.repeat(3)}\n\n## Chat heading`)
  await chat.getByRole("button", { name: "Send message" }).click()
  await expect(chat.locator(".chat-message-body")).toContainText("Старший инженер платформы")
  await expect(chat.locator(".chat-message-body")).toHaveCSS("font-family", /Fira Sans/)
  const chatSectionHeading = chat.locator(".chat-message-body h2")
  await expect(chatSectionHeading).toHaveCSS("font-family", /Caveat/)
  await assertNoHorizontalClipping(page, ".chat-dialog, .chat-messages-log, .chat-message-item, .chat-message-body")
  await assertNoHiddenVerticalOverflow(page, ".chat-dialog, .chat-messages-log, .chat-message-item, .chat-message-body")
  await chat.getByRole("button", { name: "Close", exact: true }).click()

  await page.getByRole("button", { name: "Menu", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await settings.getByRole("tab", { name: "Identity", exact: true }).click()
  await expect(settings.getByLabel("Name", { exact: true })).toBeVisible()
  await expect(settings.getByLabel("Name", { exact: true })).toHaveCSS("font-family", /Caveat/)
  await settings.getByRole("tab", { name: "settings.json", exact: true }).click()
  await expect(settings.getByLabel("Workspace settings JSON")).toHaveCSS("font-family", /Fira Code/)
  await assertNoHorizontalClipping(page, '[role="dialog"]')
  await assertReachable(settings.getByRole("tab", { name: "Workspace", exact: true }))
})

test("Given local font requests fail, when board and details render, then fallback keeps UI visible and edits persist", async ({ page }) => {
  await page.route("**/assets/*.woff2", route => route.abort())
  await page.goto("/")
  await createJobSearchWorkspace(page, "Fallback test")
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  const create = page.getByRole("dialog", { name: /Add item|Item details/ })
  await create.getByLabel("Company *").fill("Fallback Systems")
  await create.getByLabel("Role *").fill("Reading Engineer")
  await create.getByPlaceholder("Description or notes...").fill("Сохранённый текст при недоступном локальном шрифте")
  await create.getByRole("button", { name: "Create item" }).click()
  const detail = page.getByRole("dialog", { name: "Lead details" })
  await expect(detail.locator(".detail-copy")).toContainText("Сохранённый текст")
  await expect(detail.getByRole("button", { name: "Close detail" })).toBeVisible()
  await assertNoHorizontalClipping(page, ".detail-layout, .detail-primary")
  await assertReachable(detail.getByRole("button", { name: "Close detail" }))
})

test("Given 200% root text scaling and reduced motion, when board, details, chat and settings open, then content and controls remain reachable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  // Root-size scaling exercises rem-based layout; it does not emulate browser text-only zoom.
  await page.evaluate(() => { document.documentElement.style.fontSize = "40px" })
  await createJobSearchWorkspace(page, "Accessible reading")
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  const create = page.getByRole("dialog", { name: /Add item|Item details/ })
  await create.getByLabel("Company *").fill("Readable Systems")
  await create.getByLabel("Role *").fill("Platform Engineer")
  await create.getByPlaceholder("Description or notes...").fill(longText)
  await create.getByRole("button", { name: "Create item" }).click()
  const detail = page.getByRole("dialog", { name: "Lead details" })
  await assertReachable(detail.getByRole("button", { name: "Close detail" }))
  await assertNoHorizontalClipping(page, ".column, .lead-card")
  await assertNoHiddenVerticalOverflow(page, ".detail-copy, .chat-message-body")
  await assertNoHorizontalClipping(page, ".detail-layout, .detail-primary")
  await detail.getByRole("button", { name: "Close detail" }).click()
  await page.getByRole("button", { name: "Workspace chat" }).click()
  const chat = page.getByRole("dialog", { name: "Workspace chat" })
  await assertReachable(chat.getByRole("textbox", { name: "Message" }))
  await assertReachable(chat.getByRole("button", { name: "Close", exact: true }))
  await assertNoHorizontalClipping(page, ".chat-dialog, .chat-messages-log")
  await assertNoHiddenVerticalOverflow(page, ".chat-dialog, .chat-messages-log, .chat-message-body")
  await chat.getByRole("button", { name: "Close", exact: true }).click()
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const settings = page.getByRole("dialog", { name: "Settings" })
  await assertReachable(settings.getByRole("tab", { name: "Identity", exact: true }))
  await assertNoHorizontalClipping(page, '[role="dialog"]')
})
