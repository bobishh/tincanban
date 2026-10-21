import { onScopeDispose, readonly, ref, watch, type Ref } from "vue"
import type { BoardFilters } from "../filters"

/** Keep input immediate while coalescing matching, field reveal and excerpts. */
export function useBoardSearch(search: Ref<string>, workspaceId: () => string, filters: Ref<BoardFilters>) {
  const normalize = () => search.value.trim().toLowerCase()
  const query = ref(normalize())
  let pending: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { clearTimeout(pending); pending = undefined }
  const present = () => { cancel(); query.value = normalize() }
  watch(search, () => {
    cancel()
    const next = normalize()
    if (!next || next === query.value) { query.value = next; return }
    const workspace = workspaceId()
    pending = setTimeout(() => {
      pending = undefined
      if (workspaceId() === workspace) query.value = next
    }, 60)
  }, { flush: "sync" })
  watch(filters, present, { deep: true, flush: "sync" })
  watch(workspaceId, () => { cancel(); query.value = "" }, { flush: "sync" })
  onScopeDispose(cancel)
  return readonly(query)
}
