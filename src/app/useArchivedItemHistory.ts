import { computed, onScopeDispose, ref, shallowRef, watch } from "vue"
import type { AppBoardContext } from "./useAppBoard"
import type { HistoryEntry } from "../domain/history"
import type { createWorkspaceArchivedHistorySession } from "./workspaceArchivedHistory"

type Session = Awaited<ReturnType<typeof createWorkspaceArchivedHistorySession>>

/** Explicit, paged archive browsing; selection changes invalidate every outstanding read. */
export function useArchivedItemHistory(core: Pick<AppBoardContext, "tincanban" | "selectedItemId" | "sync"> & Partial<Pick<AppBoardContext, "selectedLeadId">>) {
  const selectedHistoryItemId = computed(() => core.selectedItemId.value ?? core.selectedLeadId?.value ?? null)
  const archivedItemHistory = shallowRef<HistoryEntry[]>([])
  const archivedHistoryLoading = ref(false), archivedHistoryError = ref(""), archivedHistoryNotice = ref("")
  const archivedHistoryHasMore = ref(true)
  let generation = 0, session: Promise<Session> | undefined
  const reset = () => {
    generation++
    const previous = session; session = undefined
    void previous?.then(value => value.dispose(), () => {})
    archivedItemHistory.value = []; archivedHistoryLoading.value = false; archivedHistoryHasMore.value = true
    archivedHistoryError.value = ""; archivedHistoryNotice.value = ""
  }
  watch([() => core.tincanban.activeWorkspace.id, selectedHistoryItemId], reset, { flush: "sync" })
  onScopeDispose(reset)
  const currentSession = () => {
    const itemId = selectedHistoryItemId.value, workspaceId = core.tincanban.activeWorkspace.id, captured = generation
    if (!itemId) throw new Error("Select an item before reading its history")
    const ensureSelected = () => {
      if (generation !== captured || selectedHistoryItemId.value !== itemId || core.tincanban.activeWorkspace.id !== workspaceId) {
        throw new Error("History selection changed")
      }
    }
    return session ??= import("./workspaceArchivedHistory").then(module => {
      ensureSelected()
      return module.createWorkspaceArchivedHistorySession(core.tincanban, workspaceId, itemId, ensureSelected,
        core.sync?.fetchHistoryObject, core.sync?.fetchHistoryBaseline, core.sync?.fetchHistoryDocument)
    }).catch(error => { if (captured === generation) session = undefined; throw error })
  }
  const loadEarlierItemHistory = async () => {
    if (archivedHistoryLoading.value || !archivedHistoryHasMore.value) return
    const captured = generation
    archivedHistoryLoading.value = true; archivedHistoryError.value = ""; archivedHistoryNotice.value = ""
    try {
      const page = await (await currentSession()).loadNext()
      if (captured !== generation) return
      archivedItemHistory.value = [...archivedItemHistory.value, ...page.entries]
      archivedHistoryHasMore.value = page.hasMore
      if (!page.entries.length && !page.hasMore) archivedHistoryNotice.value = "No earlier archived versions"
    } catch (error) {
      if (captured === generation) archivedHistoryError.value = error instanceof Error ? error.message : "Could not read earlier history"
    } finally { if (captured === generation) archivedHistoryLoading.value = false }
  }
  const readArchivedItemVersion = async (hash: string) => {
    if (!archivedItemHistory.value.some(entry => entry.hash === hash)) return undefined
    return (await currentSession()).readVersion(hash)
  }
  return { selectedHistoryItemId, archivedItemHistory, archivedHistoryLoading, archivedHistoryError, archivedHistoryNotice,
    archivedHistoryHasMore, loadEarlierItemHistory, readArchivedItemVersion }
}
