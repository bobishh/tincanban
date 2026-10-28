import { MeshTraceBuffer, type MeshTraceEvent, type MeshTraceLevel } from "@meta-uber/mesh-transport"
import type * as Telemetry from "./telemetry"
import { telemetryConfig } from "./telemetryConfig"

export type { MeshTraceEvent, MeshTraceLevel }

let verboseConsoleLogging = typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("syncTrace") === "1"
const traceBuffer = new MeshTraceBuffer("tincanban.mesh", 500, {
  info: line => { if (verboseConsoleLogging) console.info(line) },
  warn: (line: string) => writeConsoleWarning(line),
})
const automaticLifecycle = new Set(["node.started", "credential.prepared", "session.started", "session.closed", "session.recovery.started"])
const incidentWindowMs = 60_000
const maxIncidentsPerWindow = 120
let incidentWindowStart: number | undefined
let incidentCount = 0
let suppressedCount = 0
let telemetryModule: Promise<typeof Telemetry> | undefined
let consoleWindowStart: number | undefined
let consoleWarningCount = 0
let consoleSuppressedCount = 0

function writeConsoleWarning(line: string) {
  if (typeof window === "undefined" || verboseConsoleLogging) { console.warn(line); return }
  const now = Date.now()
  if (consoleWindowStart === undefined || now < consoleWindowStart || now - consoleWindowStart >= incidentWindowMs) {
    if (consoleSuppressedCount) console.warn(`[tincanban.mesh] ${JSON.stringify({
      event: "mesh.console.suppressed", suppressedCount: consoleSuppressedCount,
    })}`)
    consoleWindowStart = now
    consoleWarningCount = 0
    consoleSuppressedCount = 0
  }
  if (consoleWarningCount < maxIncidentsPerWindow) { consoleWarningCount++; console.warn(line) }
  else consoleSuppressedCount++
}

function loadTelemetry() {
  return telemetryModule ??= import("./telemetry").catch(cause => { telemetryModule = undefined; throw cause })
}

function resetIncidentBudget() {
  incidentWindowStart = undefined
  incidentCount = 0
  suppressedCount = 0
}

function admitIncident(timestampMs: number, trackSuppression: boolean): { admitted: boolean; suppression?: { suppressedCount: number; elapsedMs: number } } {
  let suppression: { suppressedCount: number; elapsedMs: number } | undefined
  if (incidentWindowStart === undefined || timestampMs < incidentWindowStart || timestampMs - incidentWindowStart >= incidentWindowMs) {
    if (suppressedCount && incidentWindowStart !== undefined) suppression = { suppressedCount, elapsedMs: Math.max(0, timestampMs - incidentWindowStart) }
    incidentWindowStart = timestampMs
    incidentCount = suppression ? 1 : 0
    suppressedCount = 0
  }
  if (incidentCount >= maxIncidentsPerWindow) {
    if (trackSuppression) suppressedCount++
    return { admitted: false }
  }
  incidentCount++
  return { admitted: true, suppression }
}

/** Keeps routine mesh events out of the console while retaining them for diagnostic snapshots. */
export function setMeshTraceVerboseLogging(enabled: boolean) {
  verboseConsoleLogging = enabled
}

export function meshTrace(event: string, detail: Record<string, unknown> = {}, level: MeshTraceLevel = "info", error?: unknown) {
  traceBuffer.trace(event, detail, level)
  if (typeof window === "undefined") return
  if (!telemetryConfig().enabled) { resetIncidentBudget(); return }
  const automatic = level === "warn" || automaticLifecycle.has(event)
  const timestampMs = Date.now()
  const admission = automatic ? admitIncident(timestampMs, !verboseConsoleLogging) : { admitted: false, suppression: undefined }
  if (!admission.admitted && !verboseConsoleLogging) return
  const cause = error ?? detail.error ?? (level === "warn" && typeof detail.reason === "string" ? new Error(detail.reason) : undefined)
  void loadTelemetry().then(module => {
    if (!telemetryConfig().enabled || !admission.admitted && !verboseConsoleLogging) return
    if (admission.suppression) module.record("mesh.diagnostics.suppressed", { timestampMs, ...admission.suppression }, "error")
    module.record(event, { timestampMs, ...detail, error: cause }, level)
  }).catch(() => {})
}

export function meshTraceSnapshot(): MeshTraceEvent[] {
  return traceBuffer.snapshot()
}

export function clearMeshTrace() {
  traceBuffer.clear()
  resetIncidentBudget()
  consoleWindowStart = undefined
  consoleWarningCount = 0
  consoleSuppressedCount = 0
}
