import { telemetryConsent } from "./sync/telemetryConfig"

export type UsageAction = "item_open" | "item_create" | "item_move" | "chat_send" | "workspace_create"

/** Local application intent; an optional deployment extension may observe it. */
export function startUsageAnalytics(path: "/app" | "/boards"): () => void {
  if (telemetryConsent() && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("application:surface", { detail: { path } }))
  }
  return () => {}
}

export function recordUsageAction(event: UsageAction): void {
  if (telemetryConsent() && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("application:action", { detail: { event } }))
  }
}
