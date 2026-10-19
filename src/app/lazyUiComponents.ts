import { defineAsyncComponent, h, ref, type Component } from "vue"

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

export const WorkspacesDialog = defineAsyncComponent<Component>(() => import("../components/WorkspacesDialog.vue"))
export const ColumnDialog = defineAsyncComponent<Component>(() => import("../components/ColumnDialog.vue"))
export const SchemaEditorDialog = defineAsyncComponent<Component>(() => import("../components/SchemaEditorDialog.vue"))
export const MoveItemDialog = defineAsyncComponent<Component>(() => import("../components/MoveItemDialog.vue"))
export const WorkspaceSettingsPanel = defineAsyncComponent<Component>(() => import("../components/WorkspaceSettingsPanel.vue"))
export const ObjectConversationLayer = defineAsyncComponent<Component>(() => import("../components/ObjectConversationLayer.vue"))
export const MobileDrawer = defineAsyncComponent<Component>(() => import("../components/MobileDrawer.vue"))

/** Background preloading does not belong to the synchronous application graph. */
export function startOfflineDetailPreload(isReady: () => boolean) {
  let disposed = false, pending = false, stop: (() => void) | undefined
  const load = () => {
    if (disposed || pending || stop || !navigator.onLine) return
    pending = true
    void import("./offlineDetailPreload").then(module => {
      if (!disposed) stop = module.startOfflineDetailPreload(isReady)
    }).catch(() => {}).finally(() => { pending = false })
  }
  load()
  window.addEventListener("online", load)
  return () => { disposed = true; window.removeEventListener("online", load); stop?.() }
}
