import { telemetryConfig } from "./telemetryConfig"
import { record, traceDiagnosticOperation } from "./telemetry"

const markerKey = "tincanban.startup.checkpoint.v1"

function startupDiagnosticsEnabled(): boolean {
  return import.meta.env.VITE_STARTUP_DIAGNOSTICS === "1" && telemetryConfig().enabled
}

function browserContext(): Record<string, string> {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent
  return {
    browser: /Safari/.test(userAgent) && !/Chrome|Chromium|CriOS/.test(userAgent) ? "safari" : "other",
    platform: /iPhone|iPad|iPod/.test(userAgent) ? "ios" : "other",
  }
}

/** Diagnostics enter the standard OTel facade; no startup checkpoint waits for collector acknowledgement. */
function startupCheckpoint(event: string, stage: string, detail: Record<string, unknown> = {}): void {
  if (!startupDiagnosticsEnabled()) return
  try { sessionStorage.setItem(markerKey, JSON.stringify({ sessionId: crypto.randomUUID(), stage, event })) } catch { /* Optional crash breadcrumb. */ }
  record(event, { ...detail, stage, component: "startup", operation: stage, ...browserContext() }, event.endsWith("failed") ? "error" : "info")
}

export async function diagnoseStartupStep<T>(stage: string, step: () => T | Promise<T>, detail: Record<string, unknown> = {}): Promise<T> {
  if (!startupDiagnosticsEnabled()) return await step()
  const context = { ...detail, "startup.stage": stage, "code.component": "startup", "code.operation": stage }
  startupCheckpoint("startup.phase.started", stage, detail)
  const startedAt = performance.now()
  try {
    const result = await traceDiagnosticOperation(`startup.${stage}`, context, () => step())
    startupCheckpoint("startup.phase.completed", stage, { ...detail, elapsedMs: performance.now() - startedAt })
    return result
  } catch (error) {
    startupCheckpoint("startup.phase.failed", stage, { ...detail, elapsedMs: performance.now() - startedAt, error })
    throw error
  }
}

export async function beginStartupDiagnostics(): Promise<void> {
  if (!startupDiagnosticsEnabled()) return
  try {
    const previous = JSON.parse(sessionStorage.getItem(markerKey) ?? "null") as { stage?: string; event?: string } | null
    if (previous?.stage && previous.event === "startup.phase.started") startupCheckpoint("startup.previous.interrupted", previous.stage)
  } catch { /* Missing or malformed diagnostic breadcrumbs do not affect startup. */ }
  startupCheckpoint("startup.phase.started", "entry")
}
