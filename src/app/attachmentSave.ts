import type { DocumentInput } from "../types"

type AttachmentDraft = Omit<DocumentInput, "leadId">
type AttachmentSaveAuthority = { workspaceId: string; personId: string | undefined; itemExists: boolean }

export function createAttachmentSaveForItem(input: {
  itemId: string | null
  workspaceId: string
  personId: string | undefined
  current: () => AttachmentSaveAuthority
  save: (itemId: string, draft: AttachmentDraft) => Promise<unknown>
}): (draft: AttachmentDraft) => Promise<void> {
  const itemId = input.itemId
  const workspaceId = input.workspaceId
  const personId = input.personId
  return async draft => {
    if (!itemId) throw new Error("Item is no longer open")
    const current = input.current()
    if (current.workspaceId !== workspaceId) throw new Error("Workspace changed before saving attachment")
    if (current.personId !== personId) throw new Error("Identity changed before saving attachment")
    if (!current.itemExists) throw new Error("Item is no longer available")
    await input.save(itemId, draft)
  }
}
