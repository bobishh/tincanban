import { telemetryConsent } from "../sync/telemetryConfig"
import { startUsageAnalytics } from "../usageAnalytics"

let recordedForNavigation = false

export function recordPublicBoardView(boardId: string): void {
  if (recordedForNavigation || !/^[A-Za-z0-9_-]{1,128}$/.test(boardId)) return
  if (!telemetryConsent()) return
  recordedForNavigation = true
  startUsageAnalytics("/boards")
}
