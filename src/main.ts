import { createApp, type Component } from "vue"
import "./vendor/site-foundation.css"
import "./styles/design-system/tokens.css"
import "./styles/design-system/reset.css"
import "./styles/design-system/typography.css"
import "./styles/design-system/reading-fonts.css"
import "./styles/design-system/controls.css"
import "./styles/design-system/layout.css"
import "./styles/design-system/chrome.css"
import "./styles/design-system/icons.css"
import "../public/assets/primitive.css"
import "./style.css"
import { beginReleaseMonitor } from "./release/runtimeRelease"
import { canonicalizeBoardRoute, hasBoardRouteIdentityHint, isBoardAddressPath, parseBoardRoute, readBoardRouteHint } from "./app/boardRoute"

const stopReleaseMonitor = beginReleaseMonitor()
window.addEventListener("pagehide", event => { if (!event.persisted) stopReleaseMonitor() })

const boardRoute = parseBoardRoute(window.location.pathname, window.location.search, window.location.hash)
const hintedPrivateWorkspace = boardRoute ? readBoardRouteHint(boardRoute.boardId) : null
const privateRouteIndexExists = Boolean(hintedPrivateWorkspace) || hasBoardRouteIdentityHint()
if (window.location.pathname === "/service-login") {
  void import("./app/ServiceLoginApp.vue").then(({ default: ServiceLoginApp }) => createApp(ServiceLoginApp as Component).mount("#app"))
} else if (isBoardAddressPath(window.location.pathname) && !boardRoute) {
  mountPublicBoardRoute({ boardId: "", slug: "", search: window.location.search, hash: window.location.hash })
} else if (boardRoute && !privateRouteIndexExists) {
  mountPublicBoardRoute(boardRoute)
} else if (boardRoute && !hintedPrivateWorkspace) {
  // A known identity with an unseen target may already be entitled to the private board.
  // Check the exact public object first; this avoids private startup for a public link.
  void isPublicBoardRoute(boardRoute.boardId).then(isPublic => {
    if (isPublic) mountPublicBoardRoute(boardRoute)
    else mountPrivateApp()
  })
} else {
  mountPrivateApp()
}

function mountPublicBoardRoute(route: NonNullable<typeof boardRoute>) {
  void import("./public/PublicBoardApp.vue").then(({ default: PublicBoardApp }) => createApp(PublicBoardApp as Component, {
    boardId: route.boardId,
    boardSlug: route.slug,
    canonicalizeBoardRoute: (title: string) => {
      canonicalizeBoardRoute({ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash,
        state: window.history.state, replaceState: (state, pageTitle, url) => window.history.replaceState(state, pageTitle, url) }, route.boardId, title)
    },
  }).mount("#app"))
}

async function isPublicBoardRoute(boardId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(boardId)) return false
  const origin = (import.meta.env.VITE_PUBLIC_BOARD_ORIGIN as string | undefined)?.replace(/\/$/u, "")
  if (!origin) return false
  try {
    const response = await fetch(`${origin}/v1/public/boards/${encodeURIComponent(boardId)}`, {
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
    })
    return response.status !== 404 && response.ok
  } catch { return false }
}

function mountPrivateApp() {
  void Promise.all([import("./App.vue"), import("./sync/startupDiagnostics")]).then(([appModule, diagnostics]) => {
    const privateApp = appModule as unknown as { default: Component }
    return diagnostics.beginStartupDiagnostics().then(() => diagnostics.diagnoseStartupStep("mount-ui", () => createApp(privateApp.default).mount("#app")))
      .then(() => {
        void import("./usageAnalytics").then(({ startUsageAnalytics }) => startUsageAnalytics("/app")).catch(() => {})
        const loadFooter = () => { void import("./vendor/berlin-tower.js").catch(() => {}) }
        if (window.requestIdleCallback) window.requestIdleCallback(loadFooter, { timeout: 1500 })
        else window.setTimeout(loadFooter, 0)
      })
  })
}
