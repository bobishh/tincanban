/* global __TINCANBAN_BUILD_COMMIT__ */
import { telemetryConfig } from "./telemetryConfig"
import { record, traceDiagnosticOperation } from "./telemetry"
import { capturedException, type CapturedException } from "../domain/exceptionCapture"

const markerKey = "tincanban.startup.checkpoint.v1"
type Checkpoint = { stage: string; event: string; detail?: Record<string, string | number>; failure?: CapturedException; version?: string }
const activeSteps: Checkpoint[] = []
const sessionId = crypto.randomUUID()
const version = typeof __TINCANBAN_BUILD_COMMIT__ === "undefined" ? "dev" : __TINCANBAN_BUILD_COMMIT__
let firstFailure: Checkpoint | undefined

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
  record(event, { ...detail, stage, component: "startup", operation: stage, ...browserContext() }, event.endsWith("failed") ? "error" : "info")
}

function checkpointDetail(detail: Record<string, unknown> = {}): Record<string, string | number> {
  const result: Record<string, string | number> = {}
  if (typeof detail.workspaceId === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(detail.workspaceId)) result.workspaceId = detail.workspaceId
  for (const key of ["bytes", "changeCount", "operationCount"] as const) {
    const value = detail[key]
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key] = value
  }
  return result
}

function persistCheckpoint(checkpoint: Checkpoint): void {
  try { sessionStorage.setItem(markerKey, JSON.stringify({ ...checkpoint, sessionId, version })) } catch { /* Optional crash breadcrumb. */ }
}

export async function diagnoseStartupStep<T>(stage: string, step: () => T | Promise<T>, detail: Record<string, unknown> = {}): Promise<T> {
  if (!startupDiagnosticsEnabled()) return await step()
  const context = { ...detail, "startup.stage": stage, "code.component": "startup", "code.operation": stage }
  const checkpoint = { stage, event: "startup.phase.started", detail: checkpointDetail(detail) }
  activeSteps.push(checkpoint)
  persistCheckpoint(firstFailure ?? checkpoint)
  startupCheckpoint("startup.phase.started", stage, detail)
  const startedAt = performance.now()
  try {
    const result = await traceDiagnosticOperation(`startup.${stage}`, context, () => step())
    startupCheckpoint("startup.phase.completed", stage, { ...detail, elapsedMs: performance.now() - startedAt })
    return result
  } catch (error) {
    if (!firstFailure) {
      let failure: CapturedException
      try { failure = capturedException(error) } catch { failure = { "exception.type": "UnknownError" } }
      firstFailure = { ...checkpoint, event: "startup.phase.failed", failure }
    }
    persistCheckpoint(firstFailure)
    startupCheckpoint("startup.phase.failed", stage, { ...detail, elapsedMs: performance.now() - startedAt, error })
    throw error
  } finally {
    const index = activeSteps.indexOf(checkpoint)
    if (index >= 0) activeSteps.splice(index, 1)
    // A completed child must not erase its still-running parent or the first failure.
    persistCheckpoint(firstFailure ?? activeSteps.at(-1) ?? { ...checkpoint, event: "startup.phase.completed" })
  }
}

export async function beginStartupDiagnostics(): Promise<void> {
  if (!startupDiagnosticsEnabled()) return
  try {
    const raw = sessionStorage.getItem(markerKey)
    const previous = raw && raw.length <= 32_768 ? JSON.parse(raw) as Checkpoint : null
    if (previous && typeof previous.stage === "string" && /^[A-Za-z0-9_.:-]{1,96}$/.test(previous.stage)) {
      const detail = checkpointDetail(previous.detail)
      if (typeof previous.version === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(previous.version)) detail["startup.source.version"] = previous.version
      if (previous.event === "startup.phase.started") startupCheckpoint("startup.previous.interrupted", previous.stage, detail)
      if (previous.event === "startup.phase.failed" && previous.failure) {
        const error = new Error(typeof previous.failure["exception.message"] === "string"
          ? previous.failure["exception.message"].slice(0, 2_048) : "Previous startup failed")
        if (typeof previous.failure["exception.stacktrace"] === "string") error.stack = previous.failure["exception.stacktrace"].slice(0, 16_384)
        startupCheckpoint("startup.previous.failed", previous.stage, { ...detail, error, errorCode: previous.failure["exception.type"] })
      }
    }
  } catch { /* Missing or malformed diagnostic breadcrumbs do not affect startup. */ }
  firstFailure = undefined
  activeSteps.length = 0
  persistCheckpoint({ stage: "entry", event: "startup.phase.started" })
  startupCheckpoint("startup.phase.started", "entry")
}
