import { expect, test, type Page } from "./support/coverage"
import { createJobSearchWorkspace } from "./support/workspaces"

async function createLead(page: Page, company: string, description: string) {
  await page.goto("/")
  await createJobSearchWorkspace(page, `${company} board`)
  await page.getByRole("region", { name: "Lead" }).getByRole("button", { name: "Add lead to Lead" }).click()
  const form = page.getByRole("dialog", { name: "Add item" })
  await form.getByLabel("Company *").fill(company)
  await form.getByLabel("Role *").fill("Engineer")
  await form.getByLabel("Description").fill(description)
  await form.getByRole("button", { name: "Create item" }).click()
  await expect(form).toBeHidden()
  const detail = page.getByRole("dialog", { name: "Item overview" })
  await expect(detail).toBeVisible()
  return detail
}

async function addLegacySources(page: Page, notes: string, inlineNote: string) {
  return page.evaluate(async ({ notes, inlineNote }) => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const tincanban = useTincanban()
    await tincanban.whenReady()
    const lead = Object.values(tincanban.getActiveDoc()!.entities).filter(entity =>
      "body" in entity && "values" in entity && !entity.archivedAt,
    ).at(-1)
    if (!lead) throw new Error(`Job search lead missing: meta=${JSON.stringify(tincanban.activeWorkspace)} leads=${tincanban.workspace.items.length} entities=${Object.values(tincanban.getActiveDoc()!.entities).map(entity => `${entity.kind ?? "item"}:${entity.title}`).join("|")}`)
    const board = Object.values(tincanban.getActiveDoc()!.entities).find(entity => entity.kind === "board")!
    const notesFieldId = board.kind === "board" ? board.preset?.bindings["field.notes"] : undefined
    if (!notesFieldId) throw new Error("Job search Notes field missing")
    await tincanban.executeCommandAsync({ kind: "patchItem", entityId: lead.id, values: { [notesFieldId]: notes } })
    const note = await tincanban.createDocumentAsync({
      itemId: lead.id,
      kind: "note",
      title: "Interview note",
      format: "markdown",
      content: inlineNote,
    })
    await tincanban.createDocumentAsync({
      itemId: lead.id,
      kind: "cover_letter",
      title: "Cover letter.pdf",
      format: "pdf",
    })
    return { noteId: note.id, itemId: lead.id, notesFieldId }
  }, { notes, inlineNote })
}

test("Given legacy narrative sources and an attachment, when Description saves, then all text folds and attachment remains", async ({ page }) => {
  const detail = await createLead(page, "Legacy Labs", "Original description")
  await addLegacySources(page, "Legacy preset Notes", "Legacy attached note")
  await expect(detail.getByRole("button", { name: "Reviewed", exact: true })).toHaveCount(0)
  await detail.getByRole("button", { name: "Edit", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Edit item" })
  const description = form.getByLabel("Description")
  await expect(description).toHaveValue(/Original description[\s\S]*Legacy preset Notes[\s\S]*Interview note[\s\S]*Legacy attached note/)
  await expect(form.getByLabel("Notes", { exact: true })).toHaveCount(0)
  await description.fill("Edited complete narrative")
  await form.getByRole("button", { name: "Save changes" }).click()

  await expect(form).toBeHidden()
  await expect(detail.getByText("Edited complete narrative", { exact: true })).toBeVisible()
  await expect(detail.getByText("Legacy preset Notes", { exact: true })).toHaveCount(0)
  await expect(detail.getByText("Legacy attached note", { exact: true })).toHaveCount(0)
  await expect(detail.getByText("Cover letter.pdf", { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: /Open Legacy Labs/ }).click()
  const reloaded = page.getByRole("dialog", { name: "Item overview" })
  await expect(reloaded.getByText("Edited complete narrative", { exact: true })).toBeVisible()
  await expect(reloaded.getByText("Cover letter.pdf", { exact: true })).toBeVisible()
})

test("Given legacy narrative sources, when unchanged Description saves, then old text remains editable after reload", async ({ page }, testInfo) => {
  const detail = await createLead(page, "Preserved Labs", "Original body")
  await addLegacySources(page, "Original preset Notes", "Original inline note")
  await detail.getByRole("button", { name: "Edit", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Edit item" })
  const description = form.getByLabel("Description")
  await expect(description).toHaveValue(/Original body[\s\S]*Original preset Notes[\s\S]*Original inline note/)
  await page.screenshot({ path: testInfo.outputPath("description-editor.png") })
  await form.getByRole("button", { name: "Save changes" }).click()

  await expect(form).toBeHidden()
  await expect(detail.getByText("Original body", { exact: true })).toBeVisible()
  await expect(detail.getByText("Original preset Notes", { exact: true })).toBeVisible()
  await expect(detail.getByText("Original inline note", { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath("description-card.png") })
  await page.reload()
  await page.getByRole("button", { name: /Open Preserved Labs/ }).click()
  const reloaded = page.getByRole("dialog", { name: "Item overview" })
  await expect(reloaded.getByText("Original body", { exact: true })).toBeVisible()
  await expect(reloaded.getByText("Original preset Notes", { exact: true })).toBeVisible()
  await expect(reloaded.getByText("Original inline note", { exact: true })).toBeVisible()
})

test("Given a failed narrative save, when retry succeeds, then draft commits once and source remains intact until then", async ({ page }) => {
  const detail = await createLead(page, "Retry Labs", "Original text")
  const sources = await addLegacySources(page, "Original preset text", "Original note document")
  await detail.getByRole("button", { name: "Edit", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Edit item" })
  const description = form.getByLabel("Description")
  await description.fill("Retry narrative draft")
  await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = true })

  await form.getByRole("button", { name: "Save changes" }).click()

  await expect(form.getByRole("alert")).toBeVisible()
  await expect(description).toHaveValue("Retry narrative draft")
  const originalSources = await page.evaluate(async ({ itemId, notesFieldId, noteId }) => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const doc = useTincanban().getActiveDoc()!
    const item = doc.entities[itemId] as any
    const note = doc.entities[noteId] as any
    return { body: item.body, notes: item.values[notesFieldId], noteContent: note.content, noteArchivedAt: note.archivedAt }
  }, { itemId: sources.itemId, notesFieldId: sources.notesFieldId, noteId: sources.noteId })
  expect(originalSources).toEqual({ body: "Original text", notes: "Original preset text", noteContent: "Original note document", noteArchivedAt: null })
  await page.evaluate(() => { (window as any).__TINCANBAN_INJECT_STORAGE_FAILURE__ = false })
  await form.getByRole("button", { name: "Retry save" }).click()

  await expect(form).toBeHidden()
  await expect(detail.getByText("Retry narrative draft", { exact: true })).toHaveCount(1)
  await expect(detail.getByText("Original note document", { exact: true })).toHaveCount(0)
  await page.reload()
  await page.getByRole("button", { name: /Open Retry Labs/ }).click()
  const reloaded = page.getByRole("dialog", { name: "Item overview" })
  await expect(reloaded.getByText("Retry narrative draft", { exact: true })).toHaveCount(1)
})

test("Given an inline note changes while Description edit open, when stale form saves, then newer note and draft both survive", async ({ page }) => {
  const detail = await createLead(page, "Concurrent Labs", "Base description")
  const { noteId } = await addLegacySources(page, "Saved Notes", "Note before edit")
  await detail.getByRole("button", { name: "Edit", exact: true }).click()
  const form = page.getByRole("dialog", { name: "Edit item" })
  const description = form.getByLabel("Description")
  await description.fill("User's open-form draft")
  await page.evaluate(async noteId => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const tincanban = useTincanban()
    await tincanban.updateDocumentAsync(noteId, "Newer note from concurrent edit")
  }, noteId)

  await form.getByRole("button", { name: "Save changes" }).click()

  await expect(form.getByRole("alert")).toContainText(/conflict|changed|concurrent/i)
  await expect(description).toHaveValue("User's open-form draft")
  await expect(form).toBeVisible()
  const latestNote = await page.evaluate(async noteId => {
    const { useTincanban } = await import("/src/test/stateFixture.ts")
    const doc = useTincanban().getActiveDoc()!
    const note = doc.entities[noteId] as any
    return { content: note.content, archivedAt: note.archivedAt }
  }, noteId)
  expect(latestNote).toEqual({ content: "Newer note from concurrent edit", archivedAt: null })
  await form.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.getByRole("button", { name: /Open Concurrent Labs/ }).click()
  const latestDetail = page.getByRole("dialog", { name: "Item overview" })
  await expect(latestDetail.getByText("Newer note from concurrent edit", { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole("button", { name: /Open Concurrent Labs/ }).click()
  await expect(page.getByRole("dialog", { name: "Item overview" })
    .getByText("Newer note from concurrent edit", { exact: true })).toBeVisible()
})
