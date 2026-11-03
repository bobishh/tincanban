import { expect, test } from "./support/coverage"

for (const width of [320, 1280]) for (const available of [false, true]) {
  test(`Given interrupted sign-in board loading at ${width}px and ${available ? 'an edited local board' : 'only the starter'}, when loading waits or fails, then ${available ? 'keep available edits usable after failure' : 'cover the starter until retry succeeds'}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 })
    await page.goto("/")
    await expect(page.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled()
    await page.evaluate(async available => {
      const app = (await import("/src/state.ts")).useTincanban()
      await app.whenReady()
      if (available) await app.createItemAsync({ title: "Retained card", parentId: app.genericColumns.value[0]!.id })
      const { beginIdentityBoardLoading, confirmIdentityCatalogInstalled } = await import("/src/app/identityBoardLoading.ts")
      const profile = app.getCurrentProfile()!
      const pending = await beginIdentityBoardLoading(profile)
      await confirmIdentityCatalogInstalled(profile, pending)
    }, available)
    // Hold the real loader at its boundary; keep the application's persisted
    // resume, error, retry and board-selection paths intact.
    await page.route("**/src/app/loadIdentityBoards.ts", async route => {
      const response = await route.fetch()
      const source = await response.text()
      const marker = "let initialSelection = app.captureWorkspaceSelection();"
      expect(source).toContain(marker)
      const gate = `await new Promise((resolve, reject) => {
        window.__finishBoardLoading = (fail) => fail
          ? reject(new Error("Your boards are waiting for an available peer or stored copy."))
          : resolve();
      });`
      await route.fulfill({ response, body: source.replace(marker, `${gate}${marker}`) })
    })
    const finish = async (fail: boolean) => {
      await page.waitForFunction(() => typeof (window as unknown as { __finishBoardLoading?: unknown }).__finishBoardLoading === "function")
      await page.evaluate(fail => {
        const fixture = window as unknown as { __finishBoardLoading(fail: boolean): void }
        fixture.__finishBoardLoading(fail)
        delete (window as unknown as { __finishBoardLoading?: unknown }).__finishBoardLoading
      }, fail)
    }
    await page.reload()
    const cover = page.getByRole("region", { name: "Loading your boards", exact: true })
    if (available) {
      await expect(page.locator('.notice-overlay').filter({ hasText: /loading.*boards/i })).toHaveCount(0)
      await page.getByRole("button", { name: "Open workspaces", exact: true }).click()
    }
    const pendingStatus = available ? page.getByRole("status").filter({ hasText: "Loading the rest of your boards" }) : cover.getByRole("status")
    await expect(pendingStatus).toBeVisible()
    if (available) {
      await expect(cover).toHaveCount(0)
      await expect(page.locator("main.shell")).not.toHaveAttribute("inert")
      await expect(page.getByRole("button", { name: "Open Retained card", exact: true })).toBeVisible()
      await expect(page.locator("main.shell")).toHaveCSS("opacity", "1")
    } else {
      await expect(cover).toHaveAttribute("aria-busy", "true")
      await expect(page.locator("main.shell")).toHaveAttribute("inert", "")
      await expect(page.locator(".board").first()).toBeHidden()
      expect(await cover.boundingBox()).toEqual({ x: 0, y: 0, width, height: 844 })
    }
    const pendingButton = await page.getByRole("button", { name: "Retry loading boards", exact: true }).boundingBox()
    await page.screenshot({ path: info.outputPath("loading.png") })
    await finish(true)
    const alert = page.getByRole("alert").filter({ hasText: "available peer or stored copy" })
    await expect(alert).toBeVisible()
    if (available) {
      await expect(cover).toHaveCount(0)
      await expect(page.locator("main.shell")).not.toHaveAttribute("inert")
      await expect(page.getByRole("button", { name: "Open Retained card", exact: true })).toBeVisible()
    } else {
      await expect(cover).toHaveAttribute("aria-busy", "false")
    }
    const retry = page.getByRole("button", { name: "Retry loading boards", exact: true })
    await expect(retry).toBeVisible()
    await expect(retry).toHaveCSS("color", "rgb(23, 23, 23)")
    if (!available) expect(await retry.boundingBox()).toEqual(pendingButton)
    await page.screenshot({ path: info.outputPath("retry.png") })
    await retry.focus()
    await expect(retry).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await retry.press("Enter")
    await expect(retry).toBeDisabled()
    await expect(pendingStatus).toBeVisible()
    if (available) {
      await expect(cover).toHaveCount(0)
      await expect(page.getByRole("button", { name: "Open Retained card", exact: true })).toBeVisible()
    } else {
      await expect(cover).toHaveAttribute("aria-busy", "true")
      await expect(page.locator("main.shell")).toHaveAttribute("inert", "")
    }
    await page.waitForFunction(() => typeof (window as unknown as { __finishBoardLoading?: unknown }).__finishBoardLoading === "function")
    await finish(false)
    await expect(cover).toHaveCount(0)
    await expect(page.locator("main.shell")).not.toHaveAttribute("inert")
    await expect(page.locator(".board").first()).toBeVisible()
    if (available) await expect(page.getByRole("button", { name: "Open Retained card", exact: true })).toBeVisible()
  })
}
