import { computed } from "vue"
import type { useAppController } from "./useAppController"
import { createAttachmentSaveForItem } from "./attachmentSave"

export function useAppItemDocumentSave(app: ReturnType<typeof useAppController>) {
  const { activeWorkspace, getActiveDoc, getCurrentProfile } = app.workspace
  const capture = (itemId: string | null) => createAttachmentSaveForItem({
    itemId,
    workspaceId: activeWorkspace.id,
    personId: getCurrentProfile()?.identity.personId,
    current: () => ({
      workspaceId: activeWorkspace.id,
      personId: getCurrentProfile()?.identity.personId,
      itemExists: itemId !== null && Boolean(getActiveDoc()?.entities[itemId]),
    }),
    save: app.actions.submitDocument,
  })
  return {
    saveSelectedItemDocument: computed(() => capture(app.board.selectedItem.value?.id ?? null)),
  }
}
