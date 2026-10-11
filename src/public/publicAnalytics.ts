import { telemetryConfig } from "../sync/telemetryConfig"

/* global __TINCANBAN_BUILD_COMMIT__ */

let recordedForNavigation = false

export function recordPublicBoardView(boardId: string): void {
  if (recordedForNavigation || !/^[A-Za-z0-9_-]{1,128}$/.test(boardId)) return
  const config = telemetryConfig()
  if (!config.enabled || config.level !== "all" || !config.endpoint || !config.browserKey) return
  recordedForNavigation = true
  if (Math.random() >= config.sampleRate) return
  void sendPublicView(config, boardId).catch(() => {})
}

async function sendPublicView(config: ReturnType<typeof telemetryConfig>, boardId: string): Promise<void> {
  const event = {
    event_id: crypto.randomUUID(), occurred_at: new Date().toISOString(), event: "public.board.viewed",
    build: typeof __TINCANBAN_BUILD_COMMIT__ === "undefined" ? "public" : __TINCANBAN_BUILD_COMMIT__,
    session_id: crypto.randomUUID(), device_id: "", workspace_id: "", entity_type: "board", entity_id: boardId,
    trace_id: "", span_id: "", parent_span_id: "", component: "public-board", operation: "view", status: "ok",
    duration_ms: 0, attrs: {},
  }
  await fetch(config.endpoint, {
    method: "POST", credentials: "omit", keepalive: true,
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.browserKey}` },
    body: JSON.stringify({ schema_version: 2, project: config.project, stream: "telemetry", source: "browser", events: [event] }),
  })
}
