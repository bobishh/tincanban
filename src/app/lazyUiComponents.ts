import { defineAsyncComponent, h, ref, watch, type Component } from "vue"

const pendingStatus = (message: string): Component => ({
  setup: () => () => h("div", { role: "status", "aria-live": "polite" }, message),
})

export const IdentityRecoveryDialog = defineAsyncComponent<Component>(() => import("../components/IdentityRecoveryDialog.vue"))
export const IdentitySettingsPanel = defineAsyncComponent<Component>(() => import("../components/IdentitySettingsPanel.vue"))
export const CausalChangeReview = defineAsyncComponent<Component>({
  loader: () => import("../components/CausalChangeReview.vue"),
  delay: 0,
  loadingComponent: pendingStatus("Loading workspace change review…"),
  errorComponent: {
    setup: () => {
      const showError = ref(true)
      return () => h("section", { "aria-label": "Workspace change review unavailable" }, [
        showError.value && h("p", { role: "alert" }, "Workspace change review could not load. Reload to retry."),
        showError.value && h("button", { class: "button button-small", type: "button", onClick: () => { showError.value = false } }, "Dismiss review error"),
        h("button", { class: "button button-small", type: "button", onClick: () => window.location.reload() }, "Reload review"),
      ])
    },
  },
  onError: (_error, _retry, fail) => fail(),
})
export const ItemDetailDialog = defineAsyncComponent<Component>({
  loader: () => import("../components/ItemDetailDialog.vue"),
  delay: 0,
  loadingComponent: pendingStatus("Opening item…"),
})
export const SpatialWindow = defineAsyncComponent<Component>({
  loader: () => import("../components/SpatialWindow.vue"),
  delay: 0,
  loadingComponent: pendingStatus("Opening details…"),
})
export const WorkspacesDialog = defineAsyncComponent<Component>(() => import("../components/WorkspacesDialog.vue"))
export const ColumnDialog = defineAsyncComponent<Component>(() => import("../components/ColumnDialog.vue"))
export const SchemaEditorDialog = defineAsyncComponent<Component>(() => import("../components/SchemaEditorDialog.vue"))
export const MoveItemDialog = defineAsyncComponent<Component>(() => import("../components/MoveItemDialog.vue"))
export const IdentityPhotoPanel = defineAsyncComponent<Component>(() => import("../components/IdentityPhotoPanel.vue"))
export const WorkspaceConnectionsPanel = defineAsyncComponent<Component>(() => import("../components/WorkspaceConnectionsPanel.vue"))

let detailChunksPromise: Promise<void> | null = null

function preloadOfflineDetailChunks() {
  if (typeof navigator === "undefined" || !navigator.onLine) return Promise.resolve()
  if (!detailChunksPromise) {
    detailChunksPromise = Promise.all([
      import("../components/SpatialWindow.vue"),
      import("../components/ItemDetailDialog.vue"),
      import("../components/ItemFormDialog.vue"),
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
