import { defineAsyncComponent, defineComponent, h, type Component } from "vue"
import DialogWindow from "../components/DialogWindow.vue"

export function createLazySyncDialog(dismiss: () => unknown, workspaceId: () => string): Component {
  const component = (failed: boolean) => defineComponent({
    inheritAttrs: false,
    render: () => h(DialogWindow, { windowId: "device-sync", workspaceId: workspaceId(), title: "Device sync", ariaLabel: "Device sync", onClose: dismiss }, { default: () => [
      h("section", { class: "dialog dialog-window-content sync-dialog-pending" }, [
        h("p", { role: failed ? "alert" : "status" }, failed ? "Sync controls could not load. Reload tincanban to retry." : "Loading sync controls…"),
        ...(failed ? [h("button", { class: "button button-primary", type: "button", onClick: () => window.location.reload() }, "Reload tincanban")] : []),
      ]),
    ] }),
  })
  return defineAsyncComponent<Component>({
    loader: () => import("../components/SyncDialog.vue"),
    loadingComponent: component(false),
    errorComponent: component(true),
    delay: 0,
  })
}
