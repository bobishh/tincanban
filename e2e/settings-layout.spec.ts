import { expect, test } from "./support/coverage"
import { ensureJobSearchWorkspace } from "./support/workspaces"

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 700 }]) {
  test(`Given Settings at ${viewport.width}px, when sections and validation change, then the window and navigation stay fixed`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.goto("/")
    await ensureJobSearchWorkspace(page)
    if (viewport.width < 640) await page.getByRole("button", { name: "Menu", exact: true }).click()
    await page.getByRole("button", { name: "Settings", exact: true }).filter({ visible: true }).click()
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
    const nav = dialog.getByRole("tablist")
    await expect(dialog).toHaveCSS("transform", "none")
    const initial = await dialog.boundingBox()
    const navigation = await nav.boundingBox()
    expect(initial!.height).toBeGreaterThanOrEqual(Math.min(700, viewport.height - 48))
    for (const section of ["Workspace", "Document templates", "Priority rules", "settings.json", "Identity"]) {
      await dialog.getByRole("tab", { name: section, exact: true }).click()
      await expect(dialog.getByRole("tabpanel")).toBeVisible()
      expect(await dialog.boundingBox()).toEqual(initial)
      expect(await nav.boundingBox()).toEqual(navigation)
    }
    await dialog.getByLabel("Name", { exact: true }).fill("Kept draft")
    await dialog.getByRole("tab", { name: "settings.json", exact: true }).click()
    await dialog.getByRole("textbox", { name: "Workspace settings JSON" }).fill("{")
    await expect(dialog.getByRole("alert")).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Apply JSON" })).toBeDisabled()
    expect(await dialog.boundingBox()).toEqual(initial)
    expect(await nav.boundingBox()).toEqual(navigation)
    await dialog.getByRole("tab", { name: "Identity", exact: true }).click()
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Kept draft")
    await expect(dialog.getByRole("tabpanel")).toHaveJSProperty("scrollTop", 0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
  })
}

for (const reducedMotion of ["reduce", "no-preference"] as const) test(`Given motion preference ${reducedMotion}, when Settings sections switch quickly, then the current section appears with the preferred transition and no stale content`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion })
  await page.goto("/")
  await page.getByRole("button", { name: "Settings", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true })
  const transitions = await dialog.evaluate(async element => {
    for (const section of ["workspace", "json", "identity"]) {
      element.querySelector<HTMLButtonElement>(`[data-settings-tab="${section}"]`)!.click()
      await new Promise(requestAnimationFrame)
    }
    return element.querySelector('[role="tabpanel"]')!.getAnimations().filter(animation => Number(animation.effect?.getTiming().duration) > 1).length
  })
  await expect(dialog.getByLabel("Name", { exact: true })).toBeVisible()
  await expect(dialog.getByRole("textbox", { name: "Workspace settings JSON" })).toHaveCount(0)
  expect(transitions).toBe(reducedMotion === "reduce" ? 0 : 1)
})
