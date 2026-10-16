import { defineAsyncComponent, defineComponent, h, type Component } from "vue"
import type { FileReference } from "../domain/entitySchemas"

type ReadFile = (file: FileReference) => Promise<Uint8Array | undefined>
type StoreFile = (file: File) => Promise<FileReference>

const statusComponent = (failed: boolean) => defineComponent({
  inheritAttrs: false,
  render: () => h("section", { class: "detail-section documents-section" }, [
    h("p", { role: failed ? "alert" : "status" }, failed
      ? "Document controls could not load. Reload tincanban to retry."
      : "Loading document controls…"),
    ...(failed ? [h("button", { class: "button button-primary", type: "button", onClick: () => window.location.reload() }, "Reload tincanban")] : []),
  ]),
})

export const LazyItemDocuments = defineAsyncComponent<Component>({
  loader: async () => {
    const [{ default: ItemDocuments }, { readAttachment, storeAttachment }] = await Promise.all([
      import("../components/ItemDocuments.vue") as Promise<{ default: Component }>, import("../attachments"),
    ])
    return defineComponent({
      inheritAttrs: false,
      setup(_, { attrs, slots }) {
        return () => h(ItemDocuments as Component, {
          ...attrs,
          readFile: (attrs.readFile as ReadFile | undefined) ?? readAttachment,
          storeFile: (attrs.storeFile as StoreFile | undefined) ?? storeAttachment,
        }, slots)
      },
    })
  },
  loadingComponent: statusComponent(false),
  errorComponent: statusComponent(true),
  delay: 0,
})
