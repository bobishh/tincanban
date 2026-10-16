import { telemetryConfig, subscribeTelemetryConfig } from "./telemetryConfig"
import type { BrowserOtelSdk, DiagnosticInput, OperationInput } from "./otelBrowserSdk"
import { setHttpDiagnosticSpanFactory } from "./httpDiagnostics"
import type { Context } from "@opentelemetry/api"

export type TelemetryStatus = {
  state: "disabled" | "ready" | "sending" | "pending" | "error"
  queued: number
  preparing: number
  dropped: number
  lastSentAt: number | null
  error: string
}
type Pending = { kind: "log"; value: DiagnosticInput } | { kind: "operation"; value: OperationInput }
const maxPending = 256
const pending: Pending[] = []
const listeners = new Set<() => void>()
let sdk: BrowserOtelSdk | undefined
let sdkPromise: Promise<BrowserOtelSdk | undefined> | undefined
let generation = 0
let dropped = 0
let stateError = ""
let lastSentAt: number | null = null
let sending = 0
let seenExceptions = new WeakSet<object>()
let globalHandlersInstalled = false

function notify() { for (const listener of listeners) listener() }
function state(): TelemetryStatus["state"] {
  if (!telemetryConfig().enabled) return "disabled"
  if (sending) return "sending"
  if (pending.length || (sdk?.exportState.queued ?? 0) > 0) return "pending"
  if (stateError) return "error"
  return "ready"
}
export function telemetryStatus(): TelemetryStatus {
  return { state: state(), queued: pending.length + (sdk?.exportState.queued ?? 0), preparing: 0,
    dropped: dropped + (sdk?.exportState.dropped ?? 0), lastSentAt, error: stateError }
}
export function subscribeTelemetryStatus(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }

function uniqueException(error: unknown): boolean {
  if (!error || typeof error !== "object") return true
  if (seenExceptions.has(error)) return false
  seenExceptions.add(error)
  return true
}
function admit(input: Pending) {
  if (!telemetryConfig().enabled) return
  if (sdk) {
    if (input.kind === "log") sdk.emit(input.value)
    else sdk.operation(input.value)
    notify()
    return
  }
  if (pending.length >= maxPending) { dropped++; notify(); return }
  pending.push(input)
  notify()
  void initialize()
}
async function initialize(): Promise<BrowserOtelSdk | undefined> {
  if (!telemetryConfig().enabled) return undefined
  if (sdk) return sdk
  if (!sdkPromise) {
    const version = generation
    const config = telemetryConfig()
    sdkPromise = import("./otelBrowserSdk").then(({ BrowserOtelSdk: Sdk }) => {
      if (!telemetryConfig().enabled || version !== generation) return undefined
      const instance = new Sdk(config, () => {
        if (!sdk) return
        sending = sdk.exportState.sending
        lastSentAt = sdk.exportState.lastSentAt
        stateError = sdk.exportState.error
        notify()
      })
      sdk = instance
      setHttpDiagnosticSpanFactory((name, attributes, parent) =>
        typeof window !== "undefined" && new URLSearchParams(window.location.search).get("syncTrace") === "1"
          ? instance.beginHttp(name, attributes, parent) : undefined)
      for (const item of pending.splice(0)) {
        if (item.kind === "log") instance.emit(item.value)
        else instance.operation(item.value)
      }
      notify()
      return instance
    }).catch(() => {
      if (version === generation) {
        stateError = "OpenTelemetry could not start. Application work continues without diagnostics."
        dropped += pending.length
        pending.length = 0
        notify()
      }
      return undefined
    }).finally(() => { sdkPromise = undefined })
  }
  return sdkPromise
}

export function record(event: string, detail: Record<string, unknown> = {}, level = "info") {
  const isFailure = isFailureEvent(event)
  if (!shouldRecord(level, isFailure) || !sampledIn()) return
  const error = detail.error
  if (error !== undefined && !uniqueException(error)) return
  const safeEvent = /^[A-Za-z0-9_.:-]{1,160}$/.test(event) ? event : "diagnostic.event"
  const effectiveLevel = isFailure && level === "warn" ? "error" : level
  const timestamp = typeof detail.timestampMs === "number" && Number.isFinite(detail.timestampMs) ? detail.timestampMs : Date.now()
  const value: DiagnosticInput = { event: safeEvent, detail, level: effectiveLevel, timestamp, ...(error === undefined ? {} : { exception: error }) }
  if (sdk) sdk.emit(value)
  else admit({ kind: "log", value })
}
function isFailureEvent(event: string): boolean { return /failed|rejected|authority-changed|error/i.test(event) }
function shouldRecord(level: string, isFailure: boolean): boolean {
  return telemetryConfig().enabled && (telemetryConfig().level !== "errors" || level === "error" || level === "fatal" || isFailure)
}
function sampledIn(): boolean { return Math.random() < telemetryConfig().sampleRate }

export async function traceDiagnosticOperation<T>(
  name: string,
  attributes: Record<string, string | number>,
  operation: (context?: Context) => Promise<T> | T,
): Promise<T> {
  const selected = telemetryConfig().enabled && sampledIn()
  const startedAt = performance.now()
  const activeSdk = selected ? sdk : undefined
  let active: ReturnType<BrowserOtelSdk["startOperation"]> | undefined
  try { active = activeSdk?.startOperation(name, attributes, startedAt) } catch { dropped++ }
  function finish(exception?: unknown) {
    if (!selected) return
    try {
      if (activeSdk) {
        if (active) activeSdk.finishOperation(active.span, active.context, name, attributes, performance.now(), exception)
      }
      else admit({ kind: "operation", value: { name, attributes, startedAt, endedAt: performance.now(), exception } })
    } catch { dropped++ }
  }
  try {
    const result = await operation(active?.context)
    finish()
    return result
  } catch (exception) {
    finish(exception)
    throw exception
  }
}

export function retryTelemetry() {
  if (!telemetryConfig().enabled) return
  stateError = ""
  if (sdk) void sdk.forceFlush()
  else void initialize()
  notify()
}

function installGlobalHandlers() {
  if (globalHandlersInstalled || typeof window === "undefined") return
  globalHandlersInstalled = true
  window.addEventListener("error", event => {
    const error: unknown = event.error as unknown ?? new Error(event.message || "Uncaught browser error")
    record("browser.error", { error }, "error")
  })
  window.addEventListener("unhandledrejection", event => {
    const error: unknown = event.reason as unknown ?? new Error("Unhandled promise rejection")
    record("browser.unhandled_rejection", { error }, "error")
  })
}
installGlobalHandlers()

subscribeTelemetryConfig(() => {
  generation++
  const active = sdk
  sdk = undefined
  sdkPromise = undefined
  setHttpDiagnosticSpanFactory(undefined)
  dropped += pending.length
  pending.length = 0
  sending = 0
  stateError = ""
  lastSentAt = null
  seenExceptions = new WeakSet<object>()
  if (active) {
    const shutdown = active.shutdown()
    dropped += active.exportState.dropped
    void shutdown
  }
  notify()
})

if (telemetryConfig().enabled) void initialize()
