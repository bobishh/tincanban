import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

async function addLead(page: import("@playwright/test").Page, input: { company: string; role: string; priority: string; workMode: string; fit: string }) {
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  const form = page.getByRole("dialog", { name: /Add item|Item details/ })
  await form.getByLabel("Company *").fill(input.company)
  await form.getByLabel("Role *").fill(input.role)
  await form.getByLabel("Priority").selectOption(input.priority)
  await form.getByLabel("Work mode").selectOption(input.workMode)
  await form.getByLabel("Fit score").fill(input.fit)
  await form.getByRole("button", { name: "Create item" }).click()
  await page.getByRole("button", { name: "Close detail" }).click()
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) test(`Given local runtime is still loading at ${viewport.width}px, when tincanban opens, then the startup cover stays visible until cards arrive`, async ({ page }) => {
  await page.setViewportSize(viewport)
  await page.addInitScript(() => {
    const instantiateStreaming = WebAssembly.instantiateStreaming.bind(WebAssembly)
    const released = new Promise<void>(resolve => {
      window.addEventListener("match:release-automerge", () => resolve(), { once: true })
    })
    WebAssembly.instantiateStreaming = async (source, imports) => {
      await released
      return instantiateStreaming(source, imports)
    }
  })
  await page.goto("/", { waitUntil: "domcontentloaded" })
  const status = page.getByRole("status", { name: "Board status" })
  await expect(status).toBeVisible()
  await expect(status).toContainText("Starting local checks")
  await expect(page.locator(".topbar")).toBeHidden()
  await expect(page.locator(".topbar")).toHaveAttribute("inert", "")
  await expect(page.locator(".boot-placeholder")).toHaveCount(0)
  await expect(status).toHaveClass(/startup-screen/)
  expect((await status.boundingBox())!.height).toBeGreaterThan(64)
  await page.evaluate(() => window.dispatchEvent(new Event("match:release-automerge")))
  await expect(page.getByRole("region", { name: "Untitled" })).toBeVisible()
  await expect(status).toHaveCount(0)
})

test("Given a saved base CV, when a generated PDF is attached to a lead, then it keeps template provenance and rejects incomplete artifacts", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  await page.getByRole("button", { name: "Settings" }).click()
  const templates = page.getByRole("dialog", { name: "Settings" })
  await templates.getByRole("tab", { name: "Workspace", exact: true }).click()
  await templates.getByRole("tab", { name: "Document templates" }).click()
  await templates.getByLabel("Name").fill("General software CV")
  await templates.getByLabel("Markdown").fill("# Candidate\n\nExperience")
  await templates.getByRole("button", { name: "Save template" }).click()
  await expect(templates.getByRole("button", { name: "General software CV" })).toBeVisible()
  await templates.getByRole("button", { name: "Dismiss" }).click()

  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  await page.getByLabel("Company *").fill("Cleo")
  await page.getByLabel("Role *").fill("Ruby Engineer")
  await page.getByRole("button", { name: "Create item" }).click()

  await page.getByRole("button", { name: "+ PDF" }).click()
  const artifactForm = page.locator("form.document-form").first()
  await artifactForm.getByRole("button", { name: "Attach PDF" }).click()
  await expect(artifactForm.getByRole("alert")).toHaveText("Title, base template, and PDF path required")
  await expect(page.getByText("No generated PDFs")).toBeVisible()

  await artifactForm.getByLabel("Title").fill("Cleo CV")
  await artifactForm.getByLabel("Base template").selectOption({ label: "General software CV" })
  await artifactForm.getByLabel("PDF path").fill("/tmp/cleo-cv.pdf")
  await artifactForm.getByRole("button", { name: "Attach PDF" }).click()

  await expect(page.getByText("Cleo CV")).toBeVisible()
  await expect(page.getByText("CV PDF · from template")).toBeVisible()
})

test("Given an archived card, when Archive opens, then it expands into a filtered column and can collapse again", async ({ page }) => {
  await page.goto("/")
  await addLead(page, { company: "Cleo", role: "Ruby Engineer", priority: "p1", workMode: "remote", fit: "8" })
  await page.getByRole("button", { name: "Open Cleo — Ruby Engineer" }).click()
  await page.getByRole("button", { name: "Archive", exact: true }).click()
  await page.getByRole("button", { name: "Close detail" }).click()

  await expect(page.getByRole("button", { name: "Open archive with 1 cards" })).toBeVisible()
  const archive = page.locator(".bin-column")
  const foldedWidth = await archive.evaluate(element => element.getBoundingClientRect().width)
  await page.getByRole("button", { name: "Open archive with 1 cards" }).click()
  await expect.poll(() => archive.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(foldedWidth + 100)
  await expect(page.locator(".bin-column")).toHaveClass(/bin-column-open/)
  await expect(page.locator(".bin-column").getByRole("button", { name: "Open Cleo — Ruby Engineer" })).toBeVisible()

  await page.getByPlaceholder("Search company, role, notes").fill("missing")
  await expect(page.getByText("No matching cards", { exact: true })).toBeVisible()
  await expect(page.locator(".board > .column")).toHaveCount(0)
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await page.getByRole("button", { name: "Collapse archive" }).click()
  await expect(page.getByRole("button", { name: "Open archive with 1 cards" })).toBeVisible()
  await expect.poll(() => archive.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(foldedWidth + 24)

  await page.reload()
  await expect(page.getByRole("button", { name: "Open archive with 1 cards" })).toBeVisible()
  await expect.poll(() => archive.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(foldedWidth + 24)
  await page.getByRole("button", { name: "Open archive with 1 cards" }).click()
  await expect.poll(() => archive.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(foldedWidth + 100)
  await expect(archive.getByRole("button", { name: "Open Cleo — Ruby Engineer" })).toBeVisible()
  await page.getByRole("group", { name: "Filters" }).getByRole("combobox", { name: "Status", exact: true }).selectOption({ label: "Archive" })
  await expect(page.locator(".board > .column")).toHaveCount(1)
  await expect(page.locator(".bin-column")).toHaveClass(/bin-column-open/)
  await expect(page.locator(".bin-column").getByRole("button", { name: "Open Cleo — Ruby Engineer" })).toBeVisible()
  await expect(page.locator(".bin-column").getByText("Remote", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Clear search and filters" }).click()
  await expect(page.getByRole("button", { name: "Collapse Archive" })).toBeVisible()
  await page.getByRole("button", { name: "Collapse Archive" }).click()
  await expect(page.getByRole("button", { name: "Open archive with 1 cards" })).toBeVisible()
  await expect.poll(() => archive.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(foldedWidth + 24)
})

test("Given several leads, when filters intersect, then only matching cards remain and an empty result is explicit", async ({ page }) => {
  await page.goto("/")
  await addLead(page, { company: "Cleo", role: "Ruby", priority: "p0", workMode: "remote", fit: "9" })
  await addLead(page, { company: "VREY", role: "Product", priority: "p3", workMode: "hybrid", fit: "4" })

  const filters = page.getByRole("group", { name: "Filters" })
  await filters.getByLabel("Priority").selectOption({ label: "P1" })
  await expect(page.getByText("No matching cards", { exact: true })).toBeVisible()

  await filters.getByLabel("Priority").selectOption({ label: "P0" })
  await filters.getByLabel("Work mode").selectOption({ label: "Remote" })
  await filters.getByLabel("Fit score minimum").fill("8")
  await expect(page.getByRole("button", { name: "Open Cleo — Ruby" })).toBeVisible()
  await expect(page.getByRole("button", { name: "Open VREY — Product" })).toHaveCount(0)
})

test("Given a mid-size desktop viewport, when tincanban opens, then the title and filters stay legible without clipped controls", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  await page.goto("/")
  await ensureJobSearchWorkspace(page)

  await expect(page.getByRole("heading", { name: "TINCANBAN" })).toBeVisible()
  const toolbar = await page.getByRole("region", { name: "tincanban controls" }).evaluate((element) => {
    const search = element.querySelector<HTMLElement>(".search-field")!
    const selects = [...element.querySelectorAll<HTMLSelectElement>("select")]
    const workModeLabel = selects.find((select) => select.labels?.[0]?.textContent?.includes("Work mode"))!.labels![0]
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      searchWidth: search.getBoundingClientRect().width,
      selectWidths: selects.map((select) => select.getBoundingClientRect().width),
      workModeLabelHeight: workModeLabel.getBoundingClientRect().height,
    }
  })

  expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth)
  expect(toolbar.searchWidth).toBeGreaterThanOrEqual(220)
  expect(Math.min(...toolbar.selectWidths)).toBeGreaterThanOrEqual(150)
  expect(toolbar.workModeLabelHeight).toBeLessThanOrEqual(70)
})

test("Given an iPhone 17e portrait viewport, when tincanban opens, then filters start closed and columns snap one page at a time", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/")

  const filters = page.getByRole("group", { name: "Filters" })
  await expect(filters).toBeHidden()
  await page.getByRole("button", { name: "Filters", exact: true }).click()
  await expect(filters).toBeVisible()

  const layout = await page.locator(".board").evaluate((board) => {
    const column = board.querySelector<HTMLElement>(".column")!
    const styles = getComputedStyle(board)
    return { clientWidth: board.clientWidth, scrollWidth: board.scrollWidth, columnWidth: column.getBoundingClientRect().width, snap: styles.scrollSnapType }
  })
  expect(layout.columnWidth).toBeLessThan(layout.clientWidth)
  expect(layout.scrollWidth).toBeGreaterThan(layout.clientWidth)
  expect(layout.snap).toContain("x")
})

test("Given two tabs on one device, when one tab saves a card, then the other reads and merges IndexedDB without pairing", async ({ page }) => {
  const peer = await page.context().newPage()
  try {
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    await peer.goto("/")

    await addLead(page, { company: "Local-first", role: "Stored workspace", priority: "p1", workMode: "remote", fit: "8" })
    await expect(peer.getByRole("button", { name: "Open Local-first — Stored workspace" })).toBeVisible({ timeout: 5_000 })
  } finally {
    await peer.close()
  }
})

test("Given the board, when Sync is clicked, then members open before workspace selection without starting a node", async ({ page }) => {
  await page.goto("/")
  await ensureJobSearchWorkspace(page)
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("match_iroh")))).toBe(false)

  await page.getByRole("button", { name: "Sync", exact: true }).click()

  const dialog = page.getByRole("dialog", { name: "Device sync" })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("list", { name: "Mesh members" })).toBeVisible()
  await expect(dialog.getByRole("button", { name: "Transfer ownership" })).toHaveCount(0)
  await dialog.getByRole("button", { name: "Add someone" }).click()
  await expect(dialog.getByRole("button", { name: "Generate link", exact: true })).toBeVisible()
  await expect(dialog.getByLabel("Job search")).toBeChecked()
  await expect(dialog.getByRole("button", { name: "Add my device", exact: true })).toBeVisible()
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some((entry) => entry.name.includes("match_iroh")))).toBe(false)
})
