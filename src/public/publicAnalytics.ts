import { telemetryConfig } from "../sync/telemetryConfig"
import { startUsageAnalytics } from "../usageAnalytics"

let recordedForNavigation = false

export function recordPublicBoardView(boardId: string): void {
  if (recordedForNavigation || !/^[A-Za-z0-9_-]{1,128}$/.test(boardId)) return
  const config = telemetryConfig()
  if (!config.enabled || !config.endpoint || !config.browserKey) return
  recordedForNavigation = true
  startUsageAnalytics("/boards")
}
