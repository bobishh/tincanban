import { expect, test } from "./support/coverage"
import { populatedBoard } from "./support/detailedBoard"

test("Given two warm tabs on a detailed board, When Archive and Applied alternate between tabs, Then both catch up without rereading the history and reload keeps the final stage", async ({ page, context }, info) => {
  test.setTimeout(120_000)
  await populatedBoard(page, true)
  await page.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
    await app.reclassifyWorkspace(app.activeWorkspace.id)
  })
  const other = await context.newPage()
  await other.goto("/")
  await expect(other.getByRole("button", { name: "Open workspaces", exact: true })).toBeEnabled({ timeout: 30_000 })
  const pages = [page, other]
  for (const tab of pages) {
    await tab.evaluate(async () => {
      const app = (await import("/src/state.ts")).useTincanban()
      await app.reclassifyWorkspace(app.activeWorkspace.id)
    })
    await tab.getByRole("button", { name: "Open Performance card 0", exact: true }).click()
  }
  for (const tab of pages) await tab.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
    const { workspaceRole } = await import("/src/sync/changeAuthorization.ts")
    if (await workspaceRole(app.getActiveDoc()!, app.getCurrentProfile()!) !== "owner") throw new Error("Expected warmed owner access")
  })
  for (const tab of pages) {
    await tab.evaluate(async () => {
      ;(await import("/src/sync/meshTrace.ts")).clearMeshTrace()
      const prototype = (await import("/src/workspaceDeltaJournal.ts")).WorkspaceDeltaJournal.prototype
      const original = prototype.read
      const workspaceId = (await import("/src/state.ts")).useTincanban().activeWorkspace.id
      const state = window as Window & { coldReads?: number; accessChecks?: number; coldReadDetails?: string[] }
      state.coldReads = 0
      state.accessChecks = 0
      state.coldReadDetails = []
      prototype.read = async function (...args: Parameters<typeof original>) {
        if (args[0] === workspaceId) {
          state.coldReads!++
          state.coldReadDetails!.push(new Error("Cold read").stack ?? "Missing stack")
        }
        return original.apply(this, args)
      }
      const post = Worker.prototype.postMessage
      Worker.prototype.postMessage = function (...args: [unknown, (Transferable[] | StructuredSerializeOptions)?]) {
        const message = args[0]
        if (message && typeof message === "object" && "kind" in message && message.kind === "access" &&
          (message as { input?: { snapshot?: { workspaceId?: string } } }).input?.snapshot?.workspaceId === workspaceId) state.accessChecks!++
        return Reflect.apply(post, this, args)
      }
    })
  }
  await context.setOffline(true)
  for (const [index, stage] of ["Archive", "Applied", "Archive", "Applied", "Archive", "Applied"].entries()) {
    const writer = pages[index % 2]!
    await writer.getByRole("dialog", { name: "Lead details", exact: true }).getByRole("button", { name: stage, exact: true }).click()
    for (const tab of pages) {
      const detail = tab.getByRole("dialog", { name: "Lead details", exact: true })
      await expect(detail.getByRole("button", { name: stage, exact: true })).toHaveAttribute("aria-pressed", "true")
      await expect(detail.getByRole("status")).toHaveCount(0)
      await expect(detail.getByRole("alert")).toHaveCount(0)
    }
  }
  for (const tab of pages) {
    const trace = await tab.evaluate(async () => (await import("/src/sync/meshTrace.ts")).meshTraceSnapshot()
      .filter(event => event.event.startsWith("workspace.admission") || event.event === "document.persisted"))
    expect(trace.some(event => event.event === "workspace.admission.started")).toBe(false)
    await info.attach("cross-tab-admission", { body: JSON.stringify(trace), contentType: "application/json" })
    const work = await tab.evaluate(() => {
      const state = window as Window & { coldReads?: number; accessChecks?: number; coldReadDetails?: string[] }
      return { coldReads: state.coldReads, accessChecks: state.accessChecks, coldReadDetails: state.coldReadDetails }
    })
    await info.attach("cross-tab-work", { body: JSON.stringify(work), contentType: "application/json" })
    expect(work.coldReads).toBe(0)
    expect(work.accessChecks).toBe(0)
  }
  await context.setOffline(false)
  await page.reload()
  await expect(page.getByRole("region", { name: "Applied", exact: true }).getByRole("button", { name: "Open Performance card 0", exact: true })).toBeVisible()
  await other.close()
})
