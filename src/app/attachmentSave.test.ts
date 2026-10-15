import { describe, expect, it, vi } from "vitest"
import { createAttachmentSaveForItem } from "./attachmentSave"

describe("attachment save target", () => {
  it("keeps the original item when selection closes while file storage is pending", async () => {
    let selectedItemId: string | null = "item-a"
    const save = vi.fn(async () => {})
    const commit = createAttachmentSaveForItem({
      itemId: selectedItemId,
      workspaceId: "workspace-a",
      personId: "person-a",
      current: () => ({ workspaceId: "workspace-a", personId: "person-a", itemExists: true }),
      save,
    })

    let finishStorage!: () => void
    const storage = new Promise<void>(resolve => { finishStorage = resolve })
    const pendingSave = storage.then(() => commit({ kind: "attachment", title: "File", format: "file", file: { type: "local-file", fileId: "local-1", fileName: "file.txt" } }))
    selectedItemId = null
    expect(selectedItemId).toBeNull()
    finishStorage()
    await pendingSave

    expect(save).toHaveBeenCalledOnce()
    expect(save).toHaveBeenCalledWith("item-a", expect.objectContaining({ title: "File" }))
  })

  it("rejects a pending attachment if workspace or identity changes before commit", async () => {
    let current = { workspaceId: "workspace-b", personId: "person-a", itemExists: true }
    const save = vi.fn(async () => {})
    const commit = createAttachmentSaveForItem({
      itemId: "item-a",
      workspaceId: "workspace-a",
      personId: "person-a",
      current: () => current,
      save,
    })
    await expect(commit({ kind: "attachment", title: "File", format: "file", file: { type: "local-file", fileId: "local-1", fileName: "file.txt" } }))
      .rejects.toThrow("Workspace changed before saving attachment")
    current = { workspaceId: "workspace-a", personId: "person-b", itemExists: true }
    await expect(commit({ kind: "attachment", title: "File", format: "file", file: { type: "local-file", fileId: "local-1", fileName: "file.txt" } }))
      .rejects.toThrow("Identity changed before saving attachment")
    expect(save).not.toHaveBeenCalled()
  })

  it("rejects a pending attachment if the captured item was deleted", async () => {
    const save = vi.fn(async () => {})
    const commit = createAttachmentSaveForItem({
      itemId: "item-a",
      workspaceId: "workspace-a",
      personId: "person-a",
      current: () => ({ workspaceId: "workspace-a", personId: "person-a", itemExists: false }),
      save,
    })

    await expect(commit({ kind: "attachment", title: "File", format: "file", file: { type: "local-file", fileId: "local-1", fileName: "file.txt" } }))
      .rejects.toThrow("Item is no longer available")
    expect(save).not.toHaveBeenCalled()
  })
})
