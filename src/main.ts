import { createApp, type Component } from "vue"
import "./vendor/site-foundation.css"
import "./styles/design-system/tokens.css"
import "./styles/design-system/reset.css"
import "./styles/design-system/typography.css"
import "./styles/design-system/controls.css"
import "./styles/design-system/layout.css"
import "./styles/design-system/chrome.css"
import "./styles/design-system/icons.css"
import "../public/assets/primitive.css"
import "./style.css"

const publicBoardRoute = /^\/boards(?:\/|$)/u.test(window.location.pathname)
const publicBoardId = window.location.pathname.match(/^\/boards\/([^/]+)\/?$/u)?.[1] ?? ""
if (window.location.pathname === "/service-login") {
  void import("./app/ServiceLoginApp.vue").then(({ default: ServiceLoginApp }) => createApp(ServiceLoginApp as Component).mount("#app"))
} else if (publicBoardRoute) {
  void import("./public/PublicBoardApp.vue").then(({ default: PublicBoardApp }) => createApp(PublicBoardApp as Component, { boardId: publicBoardId }).mount("#app"))
} else {
  void Promise.all([import("./App.vue"), import("./sync/startupDiagnostics")]).then(([appModule, diagnostics]) => {
    const privateApp = appModule as unknown as { default: Component }
    return diagnostics.beginStartupDiagnostics().then(() => diagnostics.diagnoseStartupStep("mount-ui", () => createApp(privateApp.default).mount("#app")))
  })
  void import("./vendor/berlin-tower.js").catch(() => {})
}
