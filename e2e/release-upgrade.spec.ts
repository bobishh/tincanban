import { expect, test } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

test("Given an older tab below the workspace snapshot reader floor, when a baseline write is attempted, then refuse signing and retain local history", async ({ page, baseURL }) => {
  await page.goto(baseURL ?? "http://127.0.0.1:4244")
  await createJobSearchWorkspace(page, "Older reader")
  const workspaceId = await page.evaluate(async () => (await import("/src/test/stateFixture.ts")).useTincanban().activeWorkspace.id)
  const before = await page.evaluate(async id => {
    const storage = (await import("/src/storage.ts")).defaultStorage
    return (await storage.ensureHistoryProgress(id)).baselineId
  }, workspaceId)

  await page.evaluate(async () => {
    const { applyReleaseObservation } = await import("/src/release/runtimeRelease.ts")
    applyReleaseObservation({
      kind: "tincanban-release-cohort", version: 1, cohortId: "a".repeat(64),
      components: { frontend: { sourceSha: "b".repeat(40), candidateId: "newer-release", artifactSha256: "b".repeat(64) } },
      contract: { minimumWriterVersion: 2, readers: { frontend: { workspaceSnapshot: 3 } } },
    }, "a".repeat(40))
  })
  await expect(page.locator(".release-upgrade")).toContainText("This tab is read-only")
  await expect(page.getByRole("button", { name: /Add lead to/ }).first()).toBeVisible()
  await page.getByRole("button", { name: /Add lead to/ }).first().click()
  const add = page.getByRole("dialog", { name: "Add item" })
  await add.getByLabel("Company *").fill("Must stay local")
  await add.getByLabel("Role *").fill("No stale write")
  await add.getByRole("button", { name: "Create item", exact: true }).click()
  await expect(add.getByRole("alert")).toContainText("Update required")
  await expect(page.getByRole("button", { name: "Open Must stay local — No stale write", exact: true })).toHaveCount(0)

  const baselineAttempt = await page.evaluate(async () => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const { resolveLocalSigningContext } = await import("/src/domain/localSigningContext.ts")
    const app = useTincanban()
    try {
      await resolveLocalSigningContext(app.getCurrentProfile()!, "workspace-history-baseline",
        { workspaceId: app.activeWorkspace.id })
      return "allowed"
    } catch (error) { return error instanceof Error ? error.message : String(error) }
  })
  expect(baselineAttempt).toMatch(/Update required/i)
  const after = await page.evaluate(async id => {
    const storage = (await import("/src/storage.ts")).defaultStorage
    return (await storage.ensureHistoryProgress(id)).baselineId
  }, workspaceId)
  expect(after).toBe(before)
  await expect(page.locator(".release-upgrade")).toContainText("local data stays available")
})
