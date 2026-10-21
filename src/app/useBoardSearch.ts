import { readonly, ref, watch, type Ref } from "vue"
import type { BoardFilters } from "../filters"

/** Keep input immediate while coalescing matching, field reveal and excerpts. */
export function useBoardSearch(search: Ref<string>, workspaceId: () => string, filters: Ref<BoardFilters>) {
  const query = ref(search.value.trim().toLowerCase())
  watch([search, workspaceId, filters], ([value, workspace], [previous, previousWorkspace], onCleanup) => {
    const next = value.trim().toLowerCase()
    if (workspace !== previousWorkspace) query.value = ""
    else if (!next || value === previous) query.value = next
    else {
      const timer = setTimeout(() => { query.value = next }, 60)
      onCleanup(() => clearTimeout(timer))
    }
  }, { deep: true, flush: "sync" })
  return readonly(query)
}
