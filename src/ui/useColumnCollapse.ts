import { ref, watch } from "vue"
import { isArchiveColumn } from "../domain/archiveColumn"

type CollapsibleColumn = { id: string; collapsible?: boolean }

export function useColumnCollapse(workspaceId: () => string, filtersActive: () => boolean) {
  const preferences = ref<Record<string, boolean>>({})
  watch(workspaceId, id => {
    try { preferences.value = JSON.parse(localStorage.getItem(`tincanban:collapsed-columns:${id}`) || "{}") as Record<string, boolean> }
    catch { preferences.value = {} }
  }, { immediate: true })

  const isCollapsed = (column: CollapsibleColumn) =>
    Boolean(column.collapsible && !filtersActive() && (preferences.value[column.id] ?? isArchiveColumn(column)))
  function toggle(column: CollapsibleColumn) {
    if (!column.collapsible) return
    const next = !isCollapsed(column)
    preferences.value = { ...preferences.value, [column.id]: next }
    try { localStorage.setItem(`tincanban:collapsed-columns:${workspaceId()}`, JSON.stringify(preferences.value)) }
    catch { /* collapse preference is local convenience */ }
  }
  return { isCollapsed, toggle }
}
