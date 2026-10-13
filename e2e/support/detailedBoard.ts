import { expect, type Page } from "./coverage"
import { createJobSearchWorkspace } from "./workspaces"

export async function populatedBoard(page: Page, jobSearch = false) {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Open workspaces" })).toBeEnabled()
  if (jobSearch) await createJobSearchWorkspace(page, "Detailed leads")
  await page.evaluate(async jobSearch => {
    const { useTincanban } = await import("/src/state.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const { prepareLocalChangeAuthorizations } = await import("/src/sync/changeAuthorization.ts")
    const { updateReactiveState } = await import("/src/statePersistence.ts")
    const A = await import("/@id/@automerge/automerge/slim")
    const tincanban = useTincanban()
    await tincanban.whenReady()
    const waitForPendingWorkspaceWrite = async () => {
      const deadline = performance.now() + 15_000
      while (tincanban.saveState.value === "saving" && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      if (tincanban.saveState.value === "saving") throw new Error("Workspace fixture setup waited 15 seconds for pending save")
    }
    await waitForPendingWorkspaceWrite()
    const base = tincanban.getActiveDoc()!
    const board = Object.values(base.entities).find(entity => entity.kind === "board")!
    const parent = Object.values(base.entities).find(entity => entity.kind === "column" && entity.title === (jobSearch ? "Lead" : "To do"))!
    const now = new Date().toISOString()
    const doc = A.change(A.clone(base), draft => {
      for (let index = 0; index < 55; index++) {
        const id = `performance-card-${index}`
        draft.entities[id] = { id, title: `Performance card ${index}`, body: "Detailed job requirements. ".repeat(320) + " Portfolio link available on request.",
          placement: { parentId: parent.id, rank: `${index}/1` }, archivedAt: null,
          lifecycle: JSON.stringify({ state: "active", changedAt: now }),
          workflow: JSON.stringify({ columnId: parent.id, changedAt: now }),
          createdAt: now, updatedAt: now, lastActivityAt: now, values: jobSearch ? {
            [board.preset!.bindings["field.company"]!]: `Performance card ${index}`,
            [board.preset!.bindings["field.role"]!]: "Senior Software Engineer",
          } : {} }
      }
    })
    const proofs = await prepareLocalChangeAuthorizations(doc, tincanban.getCurrentProfile()!, [A.getHeads(doc)[0]!])
    await defaultStorage.commitWorkspace(doc.id, doc, A.save(doc), proofs)
    updateReactiveState(doc)
    await waitForPendingWorkspaceWrite()
  }, jobSearch)
  await expect(page.getByRole("button", { name: "Open Performance card 0", exact: true })).toBeVisible()
}

export async function moveFirst(page: Page) {
  const source = (await page.locator('[data-item-id="performance-card-0"]').boundingBox())!
  const destination = page.getByRole("region", { name: "Doing", exact: true })
  const target = (await destination.locator(".card-stack").boundingBox())!
  const sourceX = source.x + 4
  const sourceY = source.y + 4
  await page.mouse.move(sourceX, sourceY)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + 28, { steps: 15 })
  await expect(page.locator(".board-drop-gap")).toHaveAttribute("data-target-id", await destination.getAttribute("data-column-id"))
  await page.mouse.up()
}
