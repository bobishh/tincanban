import { expect, test } from "./support/coverage"

test("Given a board file contains old participant profiles, when imported on a new browser, then content survives reload under its current identity", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  const bundle = await page.evaluate(async () => {
    const { createWorkspaceDoc } = await import("/src/test/boardFixture.ts")
    const { exportWorkspaceBundleV2 } = await import("/src/domain/workspaceBundle.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const source = createWorkspaceDoc("previous-workspace", "Imported content", "previous-owner", "blank")
    const column = Object.values(source.entities).find(entity => entity.kind === "column")!
    const now = "2026-01-01T00:00:00.000Z"
    source.entities.card = {
      id: "card", title: "Retained card", body: "Saved description", values: {},
      placement: { parentId: column.id, rank: "0/1" }, archivedAt: null, createdAt: now, updatedAt: now,
    }
    for (const personId of ["previous-owner", "previous-participant"]) {
      const id = `member-profile:${personId}`
      source.entities[id] = {
        id, kind: "member_profile", personId, title: "Member profile",
        data: JSON.stringify({ avatarData: null, changedAt: now }),
        placement: { parentId: null, rank: "0/1" }, archivedAt: null, createdAt: now, updatedAt: now,
      }
    }
    return Array.from(await exportWorkspaceBundleV2(A.from(source)))
  })
  await page.locator('input[type="file"][accept*=".tincanban"]').setInputFiles({
    name: "old-board.tincanban", mimeType: "application/vnd.tincanban+zip", buffer: Buffer.from(bundle),
  })
  await expect(page.getByRole("button", { name: /^Open Retained card(?:\.|$)/ })).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  await expect(page.getByRole("button", { name: /^Open Retained card(?:\.|$)/ })).toBeVisible()
  const restored = await page.evaluate(async () => {
    const state = (await import("/src/test/stateFixture.ts")).useTincanban()
    await state.whenReady()
    const doc = state.getActiveDoc()!
    return { ownerMatches: doc.ownerPersonId === state.getCurrentProfile()!.identity.personId,
      foreignProfiles: Object.values(doc.entities).filter(entity => entity.kind === "member_profile" &&
        entity.personId !== doc.ownerPersonId).length, body: doc.entities.card!.body }
  })
  expect(restored).toEqual({ ownerMatches: true, foreignProfiles: 0, body: "Saved description" })
})

test("Given an existing local board, when its import file is corrupt, then the board remains available after reload", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Open workspaces" }).click()
  await page.locator('input[type="file"][accept*=".tincanban"]').setInputFiles({
    name: "corrupt.tincanban", mimeType: "application/vnd.tincanban+zip", buffer: Buffer.from("not a board"),
  })
  await expect(page.getByRole("dialog", { name: "Workspaces", exact: true }).getByRole("alert")).toContainText("Failed to unzip bundle")
  await page.reload()
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  await expect(page.getByText("Could not open your local data.", { exact: true })).toHaveCount(0)
})
