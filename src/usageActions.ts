import type { UsageAction } from "./usageAnalytics"

export function recordUsageAction(event: UsageAction) {
  void import("./usageAnalytics").then(module => module.recordUsageAction(event)).catch(() => {})
}
