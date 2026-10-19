/* global __TINCANBAN_BUILD_COMMIT__ */
import { capturedException, type CapturedException } from "../domain/exceptionCapture"
import { record } from "./telemetry"
import { telemetryConfig } from "./telemetryConfig"

const markerKey = "tincanban.recovery.checkpoint.v1"
const version = typeof __TINCANBAN_BUILD_COMMIT__ === "undefined" ? "dev" : __TINCANBAN_BUILD_COMMIT__
type Checkpoint = { phase: string; status: "started" | "completed" | "failed"; detail: Record<string, string | number>;
  failure?: CapturedException; version: string }
const active: Checkpoint[] = []
let firstFailure: Checkpoint | undefined

function safeDetail(detail: Record<string, unknown>): Record<string, string | number> {
  const safe: Record<string, string | number> = {}
  for (const key of ["workspace.id", "server.address", "recovery.transition_id", "code.operation"]) {
    const value = detail[key]
    if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value)) safe[key] = value
  }
  for (const key of ["bytes", "http.response.status_code"]) {
    const value = detail[key]
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safe[key] = value
  }
  return safe
}
function persist(checkpoint: Checkpoint) {
  try { sessionStorage.setItem(markerKey, JSON.stringify(checkpoint)) } catch { /* Optional diagnostic storage. */ }
}

/** Preserve the deepest unfinished operation or first redacted failure across reloads. */
export async function withRecoveryCheckpoint<T>(phase: string, detail: Record<string, unknown>,
  operation: () => Promise<T> | T): Promise<T> {
  if (!telemetryConfig().enabled) return await operation()
  if (!active.length) firstFailure = undefined
  const checkpoint: Checkpoint = { phase, status: "started", detail: safeDetail(detail), version }
  active.push(checkpoint)
  persist(firstFailure ?? checkpoint)
  try {
    const result = await operation()
    checkpoint.status = "completed"
    return result
  } catch (error) {
    if (!firstFailure) {
      let failure: CapturedException
      try { failure = capturedException(error) } catch { failure = { "exception.type": "UnknownError" } }
      firstFailure = { ...checkpoint, status: "failed", failure }
    }
    throw error
  } finally {
    const index = active.indexOf(checkpoint)
    if (index >= 0) active.splice(index, 1)
    persist(firstFailure ?? active.at(-1) ?? checkpoint)
  }
}

function readPreviousCheckpoint(): Checkpoint | undefined {
  const raw = sessionStorage.getItem(markerKey)
  const previous = raw && raw.length <= 32_768 ? JSON.parse(raw) as Checkpoint : undefined
  if (!previous || typeof previous.phase !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(previous.phase)) return undefined
  return previous
}

export function reportPreviousRecoveryDiagnostic(): void {
  if (!telemetryConfig().enabled) return
  try {
    const previous = readPreviousCheckpoint()
    if (!previous || previous.status === "completed") return
    const detail: Record<string, unknown> = { ...safeDetail(previous.detail ?? {}), phase: previous.phase }
    if (typeof previous.version === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(previous.version)) detail["recovery.source.version"] = previous.version
    if (previous.status === "failed") {
      const error = new Error(previous.failure?.["exception.message"]?.slice(0, 2_048) ?? "Previous recovery failed")
      error.stack = previous.failure?.["exception.stacktrace"]?.slice(0, 16_384)
      record("rusty.credential-recovery.previous.failed", { ...detail, error }, "error")
    } else if (previous.status === "started") record("rusty.credential-recovery.previous.interrupted", detail, "warn")
    sessionStorage.removeItem(markerKey)
  } catch { /* Invalid diagnostic breadcrumbs must not affect startup. */ }
}
