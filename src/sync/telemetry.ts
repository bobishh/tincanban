import { telemetryConfig, subscribeTelemetryConfig, type TelemetryConfig } from "./telemetryConfig"
import { diagnosticEvent, type TelemetryEvent } from "./telemetryEvent"

type Queued = { event: TelemetryEvent; queuedAt: number }
export type TelemetryStatus = { state: "disabled" | "ready" | "sending" | "pending" | "error"; queued: number; preparing: number; dropped: number; lastSentAt: number | null; error: string }
const sessionId = crypto.randomUUID()
const queue: Queued[] = []
const listeners = new Set<() => void>()
const expiryMs = 300_000
const maxQueue = 1000
const maxBytes = 64 * 1024
let status: TelemetryStatus = { state: telemetryConfig().enabled ? "ready" : "disabled", queued: 0, preparing: 0, dropped: 0, lastSentAt: null, error: "" }
let timer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
let generation = 0
let pending = 0
let failures = 0
let suspended = false
let flushing = false
let inFlight = 0
const recentErrors = new Map<string, number>()
let errorWindowStartedAt = Date.now()
let errorWindowCount = 0

function admitErrorDiagnostic(event: string, detail: Record<string, unknown>): boolean {
  if (!/failed|rejected|authority-changed/.test(event)) return false
  const now = Date.now()
  if (now - errorWindowStartedAt >= 3_600_000) { errorWindowStartedAt = now; errorWindowCount = 0; recentErrors.clear() }
  const key = `${event}:${typeof detail.workspaceId === "string" ? detail.workspaceId : ""}`
  const previous = recentErrors.get(key)
  if (errorWindowCount >= 30 || (previous !== undefined && now - previous < 300_000)) return false
  recentErrors.set(key, now)
  errorWindowCount++
  return true
}

export function telemetryStatus(): TelemetryStatus { return { ...status, queued: queue.length + pending + inFlight, preparing: pending } }
export function subscribeTelemetryStatus(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function retryTelemetry() {
  if (!telemetryConfig().enabled || flushing) return
  suspended = false
  failures = 0
  status.error = ""
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  void flush()
}
function notify() { for (const listener of listeners) listener() }
function schedule(delay: number) {
  if (timer !== undefined || flushing || suspended || !telemetryConfig().enabled) return
  timer = setTimeout(() => { timer = undefined; void flush() }, delay)
}
function expire() {
  const cutoff = Date.now() - expiryMs
  const alive = queue.filter(item => item.queuedAt > cutoff)
  status.dropped += queue.length - alive.length
  queue.splice(0, queue.length, ...alive)
}
function envelope(events: TelemetryEvent[], project: string): string {
  return JSON.stringify({ schema_version: 2, project, stream: "telemetry", source: "browser", events })
}

export function record(event: string, detail: Record<string, unknown>, level = "info") {
  const config = telemetryConfig()
  if (!config.enabled || suspended || (config.level === "errors" && !admitErrorDiagnostic(event, detail))) return
  if (queue.length + pending + inFlight >= maxQueue) { status.dropped++; notify(); return }
  const version = generation
  const timestamp = typeof detail.timestampMs === "number" && Number.isFinite(detail.timestampMs) ? detail.timestampMs : Date.now()
  pending++
  void (async () => {
    try {
      const { bootstrapIdentity } = await import("../domain/identity")
      const profile = await bootstrapIdentity()
      const diagnostic = await diagnosticEvent(event, detail, { project: config.project, sessionId, deviceId: profile.device.deviceId, timestamp, level })
      if (version !== generation) return
      if (suspended) { status.dropped++; return }
      const sampleKey = diagnostic.trace_id || diagnostic.event_id.replaceAll("-", "")
      if (!diagnostic.event || parseInt(sampleKey.slice(0, 8), 16) / 0x1_0000_0000 >= config.sampleRate) return
      queue.push({ event: diagnostic, queuedAt: Date.now() })
      if (!flushing) status.state = "pending"
      schedule(2000)
    } catch {
      if (version === generation) { status.dropped++; status.error = "A diagnostic event could not be prepared." }
    } finally {
      if (version === generation) { pending--; notify() }
    }
  })()
}

function takeBatch(project: string, limit: number): Queued[] {
  const batch: Queued[] = []
  while (queue.length && batch.length < limit) {
    const next = queue[0]!
    const bytes = new TextEncoder().encode(envelope([...batch.map(item => item.event), next.event], project)).byteLength
    if (bytes > maxBytes) {
      if (!batch.length) { queue.shift(); status.dropped++; continue }
      break
    }
    batch.push(queue.shift()!)
  }
  return batch
}
class IntakeRejection extends Error {
  constructor(readonly statusCode: number) { super(`HTTP ${statusCode}`) }
}
async function transmit(config: TelemetryConfig, batch: Queued[], signal: AbortSignal): Promise<void> {
  const response = await fetch(config.endpoint, { method: "POST", credentials: "omit", keepalive: true,
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${config.browserKey}` }, body: envelope(batch.map(item => item.event), config.project), signal })
  if ([400, 401, 403, 404, 413, 422].includes(response.status)) throw new IntakeRejection(response.status)
  if (!response.ok) throw new Error()
  const receipt = await response.json() as { accepted?: number }
  if (receipt.accepted !== batch.length) throw new Error()
}
function failedBatch(batch: Queued[], cause: unknown) {
  if (cause instanceof IntakeRejection) {
    suspended = true
    status.dropped += batch.length + queue.length
    queue.length = 0
    status.state = "error"
    status.error = `Diagnostic service rejected a batch (${cause.message}). Board changes are saved separately. Update the app, then resume diagnostics; the rejected batch was discarded.`
    return
  }
  queue.unshift(...batch)
  if (queue.length + pending > maxQueue) status.dropped += queue.splice(Math.max(0, maxQueue - pending)).length
  expire()
  failures++
  status.state = "pending"
  status.error = "Intake unavailable. Diagnostics are queued; application data is saved independently."
}
async function flush() {
  if (flushing || suspended || !telemetryConfig().enabled) return
  expire()
  if (!queue.length) { status.state = "ready"; notify(); return }
  if (!navigator.onLine) { status.state = "pending"; schedule(5000); notify(); return }
  const config = telemetryConfig()
  const version = generation
  const batch = takeBatch(config.project, config.batchSize ?? 50)
  if (!batch.length) { notify(); return }
  flushing = true
  inFlight = batch.length
  status.state = "sending"
  const activeController = new AbortController()
  controller = activeController
  const timeout = setTimeout(() => activeController.abort(), 5000)
  notify()
  try {
    await transmit(config, batch, activeController.signal)
    if (version !== generation) return
    failures = 0
    status.lastSentAt = Date.now()
    status.error = ""
    status.state = queue.length ? "pending" : "ready"
  } catch (cause) {
    if (version === generation) failedBatch(batch, cause)
  } finally {
    clearTimeout(timeout)
    if (version === generation) {
      flushing = false
      inFlight = 0
      controller = undefined
      if (queue.length) schedule(failures ? Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)) : 2000)
      notify()
    }
  }
}

subscribeTelemetryConfig(() => {
  generation++
  controller?.abort()
  controller = undefined
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  status.dropped += queue.length + pending + inFlight
  queue.length = 0
  pending = 0
  failures = 0
  suspended = false
  flushing = false
  inFlight = 0
  status = { ...status, state: telemetryConfig().enabled ? "ready" : "disabled", error: "", lastSentAt: null }
  notify()
})
if (typeof window !== "undefined") window.addEventListener("online", () => { if (!flushing) { if (timer !== undefined) clearTimeout(timer); timer = undefined; void flush() } })
