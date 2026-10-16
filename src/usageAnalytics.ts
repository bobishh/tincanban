import { telemetryConfig } from "./sync/telemetryConfig"

/** Aggregate usage only: fixed surfaces, no board URLs, content or personal identifiers. */
export function startUsageAnalytics(path: "/app" | "/boards"): () => void {
  const initial = telemetryConfig()
  if (!initial.enabled || !initial.endpoint || !initial.browserKey || Math.random() >= initial.sampleRate) return () => {}
  let stopped = false
  const send = (event: "page_view" | "active_read", properties: Record<string, string> = {}) => {
    if (!stopped) sendUsageEvent(event, path, properties)
  }
  send("page_view")
  if (typeof window === "undefined") return () => { stopped = true }
  let seconds = 0
  let lastActivity = Date.now()
  const activity = () => { lastActivity = Date.now() }
  document.addEventListener("pointerdown", activity, { passive: true })
  document.addEventListener("keydown", activity, { passive: true })
  const interval = window.setInterval(() => {
    if (!telemetryConfig().enabled || document.visibilityState !== "visible" || !document.hasFocus() || Date.now() - lastActivity > 60_000) return
    if (++seconds === 30) { send("active_read", { active_seconds: "30" }); window.clearInterval(interval) }
  }, 1000)
  const stop = () => {
    stopped = true
    window.clearInterval(interval)
    document.removeEventListener("pointerdown", activity)
    document.removeEventListener("keydown", activity)
    window.removeEventListener("pagehide", stop)
  }
  window.addEventListener("pagehide", stop, { once: true })
  return stop
}

function sendUsageEvent(event: string, path: "/app" | "/boards", properties: Record<string, string> = {}) {
  const config = telemetryConfig()
  if (!config.enabled || !config.browserKey || !config.endpoint) return
  try {
    void fetch(config.analyticsEndpoint ?? new URL("/events", config.endpoint).href, {
      method: "POST", credentials: "omit", keepalive: true,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.browserKey}` },
      body: JSON.stringify({ schema_version: 1, project: config.project, source: "browser", events: [{
        event_id: crypto.randomUUID(), occurred_at: new Date().toISOString(), event, path, target: "", referrer_host: "", properties,
      }] }),
    }).catch(() => {})
  } catch { /* Analytics must not interrupt board use. */ }
}

export type UsageAction = "item_open" | "item_create" | "item_move" | "chat_send" | "workspace_create"

export function recordUsageAction(event: UsageAction) {
  const config = telemetryConfig()
  if (config.enabled && Math.random() < config.sampleRate) sendUsageEvent(event, "/app")
}
