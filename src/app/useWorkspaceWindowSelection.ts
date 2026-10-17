import { watch, type Ref } from "vue"

type WindowSelection = { selectedItemId: Ref<string | null> }

/** Keep open item views local to each workspace, alongside its persisted geometry. */
export function useWorkspaceWindowSelection(workspaceId: () => string, selection: WindowSelection) {
  const remembered = new Map<string, { itemId: string | null }>()
  watch(workspaceId, (next, previous) => {
    if (previous) remembered.set(previous, { itemId: selection.selectedItemId.value })
    const saved = remembered.get(next)
    selection.selectedItemId.value = saved?.itemId ?? null
  }, { flush: "sync" })
}
