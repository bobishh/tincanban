import { expect, test, type Page } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

async function addLead(page: Page, company: string) {
  await page.getByRole("button", { name: "Add lead to Lead", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Add item" })
  await form.getByLabel("Company *").fill(company)
  await form.getByLabel("Role *").fill("Engineer")
  await form.getByRole("button", { name: "Create item" }).click()
  await expect(form).toBeHidden()
  await page.getByRole("button", { name: "Close detail" }).click()
}

for (const width of [1280, 390]) {
  test(`Given two cards at ${width}px, when hovering their gap, then add appears there and failed insertion retries in place`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto("/")
    await createJobSearchWorkspace(page, "Inline leads")
    await addLead(page, "First")
    await addLead(page, "Second")
    const column = page.getByRole("region", { name: "Lead", exact: true, includeHidden: true })
    const cards = column.locator(".lead-card")
    const add = column.getByRole("button", { name: "Add lead to Lead", exact: true })
    const lastBox = await cards.last().boundingBox()
    const addBox = await add.boundingBox()
    expect(addBox!.y - (lastBox!.y + lastBox!.height)).toBeGreaterThanOrEqual(0)
    expect(addBox!.y - (lastBox!.y + lastBox!.height)).toBeLessThan(30)

    const insert = column.getByRole("button", { name: /Add lead between cards/ })
    const gap = column.locator(".card-add-gap")
    await cards.first().hover()
    await expect(insert).toHaveCSS("opacity", "0")
    await expect(gap).toHaveCSS("height", "14px")
    const firstBox = await cards.first().boundingBox()
    const secondBox = await cards.last().boundingBox()
    await page.mouse.move(firstBox!.x + firstBox!.width / 2, (firstBox!.y + firstBox!.height + secondBox!.y) / 2)
    await expect(insert).toHaveCSS("opacity", "1")
    await expect(gap).toHaveCSS("height", "68px")
    for (const property of ["font-weight", "line-height", "padding", "text-align", "min-height"]) {
      const bottomStyle = await add.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), property)
      await expect(insert).toHaveCSS(property, bottomStyle)
    }
    await column.locator(".column-header").hover()
    await expect(gap).toHaveCSS("height", "14px")
    await expect(insert).toHaveCSS("opacity", "0")
    await gap.hover()
    await expect(gap).toHaveCSS("height", "68px")
    await insert.click()
    const form = page.getByRole("dialog", { name: "Add item" })
    await form.getByLabel("Company *").fill("Middle")
    await form.getByLabel("Role *").fill("Engineer")
    await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })
    await form.getByRole("button", { name: "Create item" }).click()
    await expect(form.getByRole("alert")).toBeVisible()
    await expect(cards).toHaveCount(2)
    await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })
    await form.getByRole("button", { name: "Retry save" }).click()
    await expect(form).toBeHidden()
    await page.getByRole("button", { name: "Close detail" }).click()
    await expect(cards.locator(".company")).toHaveText(["First", "Middle", "Second"])
    await page.reload()
    await expect(column.locator(".lead-card .company")).toHaveText(["First", "Middle", "Second"])
  })
}

test("Given the item dialog chunk fails to load, when dismissed and reloaded, then the item flow recovers", async ({ page }) => {
  let requests = 0
  await page.route(/ItemFormDialog\.vue/, route => {
    requests++
    return requests === 1 ? route.abort() : route.continue()
  })
  await page.goto("/")
  await createJobSearchWorkspace(page, "Lazy item dialog")
  await page.getByRole("button", { name: "Add lead to Lead", exact: true }).click()
  const failure = page.getByRole("alertdialog", { name: "Dialog failed to load" })
  await expect(failure.getByRole("alert")).toContainText("could not load")
  await failure.getByRole("button", { name: "Dismiss" }).click()
  await expect(failure).toBeHidden()
  await page.reload()
  await page.getByRole("button", { name: "Add lead to Lead", exact: true }).click()
  await expect(page.getByRole("dialog", { name: "Add item" })).toBeVisible()
})
