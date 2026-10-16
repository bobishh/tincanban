import { expect, test, type Page } from "./support/coverage"

async function seedFormatTwoWorkspace(page: Page, malformed = false) {
  await page.goto("/")
  return page.evaluate(async broken => {
    const { useTincanban } = await import("/src/state.ts")
    const { createWorkspaceDoc } = await import("/src/domain/seeds.ts")
    const { recordGenesisAuthority } = await import("/src/sync/changeAuthorization.ts")
    const { defaultStorage } = await import("/src/storage.ts")
    const { writeLocal } = await import("/src/localDb.ts")
    const { initializeAutomerge } = await import("/src/crdt.ts")
    const Automerge = await import("/@id/@automerge/automerge/slim")
    await initializeAutomerge()
    const { default: wasmUrl } = await import("/@id/@automerge/automerge/automerge.wasm?url")
    await Automerge.initializeWasm(wasmUrl)
    const tincanban = useTincanban()
    await tincanban.whenReady()
    const profile = tincanban.getCurrentProfile()!
    const old = createWorkspaceDoc(crypto.randomUUID(), "Older board", profile.identity.personId, "blank") as unknown as Record<string, any>
    old.formatVersion = 2
    old.deleted = false
    delete old.archivedAt
    const column = Object.values(old.entities).find((entity: any) => entity.kind === "column") as any
    const cardId = crypto.randomUUID()
    old.entities[cardId] = { id: cardId, title: "Old card", body: "Kept through migration",
      placement: { parentId: column.id, rank: "0/1" }, deleted: false, createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), values: {} }
    for (const entity of Object.values(old.entities) as Array<Record<string, any>>) {
      entity.deleted = broken && entity.kind === "column" ? "yes" : false
      delete entity.archivedAt
      if (entity.kind === "column") entity.displayHint = "normal"
    }
    if (!broken) {
      column.deleted = true
      column.archivedAt = null
    }
    const doc = Automerge.from(old)
    await recordGenesisAuthority(doc as never, profile)
    await defaultStorage.saveSnapshot(old.id, doc as never, Automerge.save(doc))
    await defaultStorage.registerWorkspace(old.id, old.title)
    const { registerWorkspaceInCurrentRoot } = await import("/src/statePersonalRoot.ts")
    await registerWorkspaceInCurrentRoot(defaultStorage, profile, old.id, "genesis")
    await writeLocal("tincanban.active_workspace_id", old.id)
    const board = Object.values(old.entities).find((entity: any) => entity.kind === "board") as any
    window.history.replaceState(null, "", `/boards/${encodeURIComponent(board.id)}/older-board`)
    return old.id as string
  }, malformed)
}

test("Given an older signed board, when owner reloads and invites a visitor, then card reaches visitor", async ({ browser, page }) => {
  test.setTimeout(90_000)
  const id = await seedFormatTwoWorkspace(page)
  await page.reload()
  await expect(page.getByRole("button", { name: "Open Old card" })).toBeVisible()
  const format = await page.evaluate(async () => {
    const { useTincanban } = await import("/src/state.ts")
    return useTincanban().getActiveDoc()?.formatVersion
  })
  expect(format).toBe(3)
  await page.getByRole("button", { name: "Sync", exact: true }).click()
  const host = page.getByRole("dialog", { name: "Device sync" })
  await host.getByRole("button", { name: "Add someone" }).click()
  await host.getByRole("button", { name: "Generate link" }).click()
  const invite = await host.getByLabel("Pairing link").inputValue()
  const context = await browser.newContext()
  try {
    const guest = await context.newPage()
    await guest.goto(invite)
    const dialog = guest.getByRole("dialog", { name: "Device sync" })
    await dialog.getByRole("button", { name: "Accept and join" }).click()
    await page.getByLabel("Participant role").selectOption("visitor")
    await page.getByRole("button", { name: "Approve access" }).click()
    await expect(dialog.getByText(/Connected to/)).toBeVisible({ timeout: 25_000 })
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click()
    await expect(guest.getByRole("button", { name: "Open Old card" })).toBeVisible()
    expect(await guest.evaluate(async () => {
      const { useTincanban } = await import("/src/state.ts")
      return useTincanban().getActiveDoc()?.id
    })).toBe(id)
  } finally { await context.close() }
})

test("Given malformed older board, when owner reloads, then migration stops and stored copy remains", async ({ page }) => {
  const id = await seedFormatTwoWorkspace(page, true)
  await page.reload()
  await expect(page.getByRole("alert")).toContainText("Could not open your local data")
  const stored = await page.evaluate(async workspaceId => {
    const { defaultStorage } = await import("/src/storage.ts")
    const loaded = await defaultStorage.loadWorkspaceDoc(workspaceId)
    return { version: loaded?.doc.formatVersion, heads: loaded?.heads.length }
  }, id)
  expect(stored).toEqual({ version: 2, heads: 1 })
})
