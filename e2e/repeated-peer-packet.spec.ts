import { expect, test } from "./support/coverage"
import { populatedBoard } from "./support/detailedBoard"

test("Given a detailed board and a committed peer packet, When duplicates repeat around a local stage change, Then history stays idle and a changed signature still fails", async ({ page }) => {
  test.setTimeout(120_000)
  await populatedBoard(page, true)
  const result = await page.evaluate(async () => {
    const app = (await import("/src/state.ts")).useTincanban()
    await app.reclassifyWorkspace(app.activeWorkspace.id)
    const { exportDocumentAuthorizationBundle } = await import("/src/sync/changeAuthorization.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const trace = await import("/src/sync/meshTrace.ts")
    const doc = app.getActiveDoc()!
    const bytes = app.getAutomergeBytes()
    const authorization = await exportDocumentAuthorizationBundle(doc, app.getCurrentProfile()!)
    await app.mergeAuthorizedWorkspace(doc.id, bytes, authorization)
    await app.executeCommandAsync({ kind: "setEntityArchived", entityId: "performance-card-0", archived: true })
    const before = await defaultStorage.readWorkspaceRevision(doc.id)
    trace.clearMeshTrace()
    for (let index = 0; index < 4; index++) await app.mergeAuthorizedWorkspace(doc.id, bytes.slice(), structuredClone(authorization))
    const after = await defaultStorage.readWorkspaceRevision(doc.id)
    const admissionRuns = trace.meshTraceSnapshot().filter(event => event.event === "workspace.admission.started").length
    const corrupted = structuredClone(authorization)
    ;(corrupted.records[0] as { signed: { signature: string } }).signed.signature += "forged"
    let rejected = ""
    try { await app.mergeAuthorizedWorkspace(doc.id, bytes.slice(), corrupted) }
    catch (error) { rejected = error instanceof Error ? error.message : String(error) }
    return { sameRevision: before === after, admissionRuns, rejected }
  })
  expect(result.sameRevision).toBe(true)
  expect(result.admissionRuns).toBe(0)
  expect(result.rejected).toMatch(/signature|authorization/i)
  await page.reload()
  await page.getByRole("region", { name: "Archive", exact: true }).getByRole("button", { name: "Open Archive with 1 cards", exact: true }).click()
  await expect(page.getByRole("button", { name: "Open Performance card 0", exact: true })).toBeVisible()
})
