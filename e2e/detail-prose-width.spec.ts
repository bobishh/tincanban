import { expect, test, type Locator } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

test.beforeEach(({ page }) => {
  page.on("pageerror", error => console.error("detail-layout pageerror", error.message))
})

const longDescription = "Readable prose should stay within a comfortable measure. ".repeat(24)
const markdownWithWideBlocks = `${longDescription}\n\n| Label | Value |\n| --- | --- |\n| Context | ${"wide-cell ".repeat(14)} |\n\n\`\`\`text\n${"long-code-token-".repeat(16)}\n\`\`\``

async function proseWidth(locator: Locator) {
  return locator.evaluate(element => ({
    width: element.getBoundingClientRect().width,
    className: element.className,
    maxInlineSize: getComputedStyle(element).maxInlineSize,
    maxWidth: getComputedStyle(element).maxWidth,
    proseLimit: (() => {
      const style = getComputedStyle(element)
      const probe = document.createElement("span")
      Object.assign(probe.style, { position: "absolute", visibility: "hidden", width: "70ch",
        fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight, fontStyle: style.fontStyle })
      document.body.append(probe)
      const limit = probe.getBoundingClientRect().width
      probe.remove()
      return limit
    })(),
    scrollWidth: element.scrollWidth,
  }))
}

async function assertQuietDetailSections(detail: Locator) {
  for (const selector of [".detail-inspector", ".detail-grid", ".detail-subsection", ".quick-note-form", ".source-snapshot", ".document-form", ".document-row", ".item-history-entry", ".subitem-row"]) {
    for (const section of await detail.locator(selector).all()) {
      await expect(section).toHaveCSS("border-top-width", "0px")
      await expect(section).toHaveCSS("border-bottom-width", "0px")
      await expect(section).toHaveCSS("border-left-width", "0px")
      await expect(section).toHaveCSS("border-image-source", "none")
    }
  }
  const quickNote = detail.locator(".quick-note-form")
  if (await quickNote.count()) {
    await expect(quickNote).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
    await expect(quickNote.locator("textarea")).toHaveCSS("border-top-width", "2px")
  }
}

test("Given a Lead detail window, when its container maximizes and then narrows, then actions stay under the title and fields reflow", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto("/")
  await createJobSearchWorkspace(page, "Readable lead")
  await page.getByRole("region", { name: "Lead" }).getByRole("button", { name: "Add lead to Lead" }).click()
  const form = page.getByRole("dialog", { name: "Add item" })
  await form.getByLabel("Company *").fill("Readable Corp")
  await form.getByLabel("Role *").fill("Engineer")
  await form.getByLabel("Description", { exact: true }).fill(longDescription)
  await form.getByRole("button", { name: "Create item" }).click()

  const detail = page.getByRole("dialog", { name: "Item overview" })
  const prose = detail.locator("[data-detail-primary] .detail-copy")
  const actions = detail.locator("[data-detail-actions]")
  const stages = detail.locator("[data-detail-stages]")
  await expect(prose.locator("p").first()).toContainText("comfortable measure")
  const leadMeasure = await proseWidth(prose)
  expect(leadMeasure.width, JSON.stringify(leadMeasure)).toBeLessThanOrEqual(leadMeasure.proseLimit + 2)
  await expect(actions).toBeVisible()
  expect((await stages.boundingBox())!.y).toBeLessThan((await prose.boundingBox())!.y)
  expect(Math.abs((await stages.boundingBox())!.x - (await detail.locator(".spatial-heading").boundingBox())!.x)).toBeLessThan(32)

  await detail.getByRole("button", { name: "Maximize window" }).click()
  await expect.poll(async () => (await detail.boundingBox())?.width ?? 0).toBeGreaterThan(1200)
  expect((await stages.boundingBox())!.y).toBeLessThan((await prose.boundingBox())!.y)
  expect(Math.abs((await stages.boundingBox())!.x - (await detail.locator(".spatial-heading").boundingBox())!.x)).toBeLessThan(32)
  await detail.screenshot({ path: testInfo.outputPath("detail-layout-wide.png") })
  await assertQuietDetailSections(detail)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(detail.locator("[data-detail-layout]")).toHaveCSS("grid-template-columns", /\d+px/)
  const primary = await detail.locator("[data-detail-primary]").boundingBox()
  expect((await actions.boundingBox())!.y).toBeLessThan(primary!.y)
  const mobileMeasure = await proseWidth(prose)
  expect(mobileMeasure.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await detail.screenshot({ path: testInfo.outputPath("detail-layout-mobile.png") })
  await assertQuietDetailSections(detail)
})

test("Given a board card description with a long link, when shown on the board, then Fira Sans prose wraps inside the card", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await page.goto("/")
  await createJobSearchWorkspace(page, "Readable card description")
  await page.getByRole("button", { name: "Add lead to Lead", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Add item" })
  await form.getByLabel("Company *").fill("Readable Corp")
  await form.getByLabel("Role *").fill("Engineer")
  await form.getByLabel("Description", { exact: true }).fill("Context and source https://example.com/" + "very-long-path-segment/".repeat(10))
  await form.getByRole("button", { name: "Create item" }).click()
  const description = page.locator(".item-card-body")
  await expect(description).toBeVisible()
  await expect(description).toHaveCSS("font-family", /Fira Sans/)
  expect(await page.evaluate(async () => (await document.fonts.load('14px "Fira Sans"', "Readable card description")).some(face => face.family.includes("Fira Sans") && face.status === "loaded"))).toBe(true)
  const card = page.locator(".item-card").filter({ hasText: "Readable Corp" })
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await expect(description.locator(".markdown-link")).toHaveCSS("overflow-wrap", "anywhere")
})

test("Given a generic item overview, when maximized then narrow, then content reflows and failure draft remains usable", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 })
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.getByRole("button", { name: "New workspace" }).click()
  const create = page.getByRole("dialog", { name: "Create workspace" })
  await create.getByLabel("Title").fill("Readable item")

  await create.getByRole("button", { name: "Create", exact: true }).click()
  await page.getByRole("button", { name: "Add item to To do" }).click()
  const form = page.getByRole("dialog", { name: "Item details" })
  await form.getByLabel("Title *").fill("Long notes")
  await form.getByLabel("Body").fill(markdownWithWideBlocks)
  await form.getByRole("button", { name: "Save item" }).click()
  await page.getByRole("button", { name: "Open Long notes" }).click()

  const detail = page.getByRole("dialog", { name: "Item overview" })
  const prose = detail.locator("[data-detail-primary] .detail-copy")
  const actions = detail.locator("[data-detail-actions]")
  const stages = detail.locator("[data-detail-stages]")
  await expect(prose.locator("table")).toBeVisible()
  expect((await proseWidth(prose)).width).toBeLessThanOrEqual((await proseWidth(prose)).proseLimit + 2)
  await expect(actions).toBeVisible()
  expect((await stages.boundingBox())!.y).toBeLessThan((await prose.boundingBox())!.y)
  await expect(prose.locator("table")).toBeVisible()
  await expect(prose.locator("pre")).toBeVisible()
  expect(await prose.locator("table").evaluate(element => getComputedStyle(element).overflowX)).toBe("auto")
  expect(await prose.locator("pre").evaluate(element => getComputedStyle(element).overflowX)).toBe("auto")

  const draft = detail.getByRole("textbox", { name: "Quick note" })
  await detail.locator("summary").filter({ hasText: /^Quick note$/ }).click()
  await draft.fill("Keep this draft on failure")
  await page.evaluate(() => { (window as unknown as { __TINCANBAN_INJECT_STORAGE_FAILURE__: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
  await detail.getByRole("button", { name: "Add note" }).click()
  await expect(detail.getByRole("alert")).toContainText("Note not saved")
  await expect(draft).toHaveValue("Keep this draft on failure")
  await assertQuietDetailSections(detail)
  await page.evaluate(() => { (window as unknown as { __TINCANBAN_INJECT_STORAGE_FAILURE__: boolean }).__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })

  await detail.getByRole("button", { name: "Maximize window" }).click()
  await expect.poll(async () => (await detail.boundingBox())?.width ?? 0).toBeGreaterThan(1200)
  expect((await actions.boundingBox())!.y).toBeLessThan((await prose.boundingBox())!.y)
  await page.setViewportSize({ width: 390, height: 844 })
  const primary = await detail.locator("[data-detail-primary]").boundingBox()
  expect((await actions.boundingBox())!.y).toBeLessThan(primary!.y)
  expect((await proseWidth(prose)).width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await assertQuietDetailSections(detail)
})
