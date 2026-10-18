import { defineAsyncComponent, h, type Component } from "vue"

const PlainText = (props: { source: string }) => h("div", { style: { whiteSpace: "pre-wrap" } }, props.source)

export const MarkdownContent = defineAsyncComponent({
  loader: () => import("../components/MarkdownContent.vue") as Promise<{ default: Component }>,
  loadingComponent: PlainText,
  errorComponent: PlainText,
  delay: 0,
})
