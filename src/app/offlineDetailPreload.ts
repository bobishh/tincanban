import { watch } from "vue"

let detailChunksPromise: Promise<void> | null = null

function preloadOfflineDetailChunks() {
  if (typeof navigator === "undefined" || !navigator.onLine) return Promise.resolve()
  if (!detailChunksPromise) {
    detailChunksPromise = Promise.all([
      import("../components/SpatialWindow.vue"),
      import("../components/QuickNoteForm.vue"),
      import("../components/ItemDetailDialog.vue"),
      import("../components/ItemFormDialog.vue"),
      import("../components/ItemDocuments.vue"),
      import("../attachmentBlobStore"),
      import("../sync/localCommandSigning"),
      import("../sync/workspaceSigning"),
      import("./narrativeEditor"),
      import("../components/ItemHistoryPanel.vue"),
      import("../attachmentFileStream").then(module => module.preloadBlobStreamStorage()),
    ]).then(() => undefined).catch(error => {
      detailChunksPromise = null
      throw error
    })
  }
  return detailChunksPromise
}

export function startOfflineDetailPreload(isReady: () => boolean) {
  let idleHandle: number | undefined
  let timerHandle: number | undefined
  const schedule = () => {
    if (!isReady() || !navigator.onLine || detailChunksPromise) return
    const preload = () => { idleHandle = undefined; timerHandle = undefined; void preloadOfflineDetailChunks().catch(() => {}) }
    if (typeof window.requestIdleCallback === "function") idleHandle = window.requestIdleCallback(preload, { timeout: 3_000 })
    else timerHandle = window.setTimeout(preload, 200)
  }
  const stopWatch = watch(isReady, schedule, { immediate: true })
  window.addEventListener("online", schedule)
  return () => {
    stopWatch()
    window.removeEventListener("online", schedule)
    if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle)
    if (timerHandle !== undefined) window.clearTimeout(timerHandle)
  }
}
