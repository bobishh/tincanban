import { ROOT_CONTEXT, trace, type Context } from "@opentelemetry/api"

const storageKey = "tincanban.diagnostic-continuation.v1"
const lifetime = 30 * 60_000
let continuation: { context: Context; expiresAt: number } | undefined

/** Diagnostic carrier only. Never used to authorize enrollment or storage access. */
export function readDiagnosticTraceparent(value: string | null | undefined): Context | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/.exec(value ?? "")
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return undefined
  return trace.setSpanContext(ROOT_CONTEXT, { traceId: match[1]!, spanId: match[2]!,
    traceFlags: Number.parseInt(match[3]!, 16), isRemote: true })
}

export function diagnosticTraceparent(context: Context | undefined): string | undefined {
  const span = context && trace.getSpanContext(context)
  return span && `00-${span.traceId}-${span.spanId}-${span.traceFlags.toString(16).padStart(2, "0")}`
}

/** Reloads in this tab continue the enrollment that produced its saved state. */
export function rememberDiagnosticContinuation(context: Context | undefined): void {
  const traceparent = diagnosticTraceparent(context)
  if (!context || !traceparent) return
  const expiresAt = Date.now() + lifetime
  continuation = { context, expiresAt }
  try { sessionStorage.setItem(storageKey, JSON.stringify({ traceparent, expiresAt })) } catch { /* Optional diagnostics. */ }
}

export function diagnosticContinuation(): Context | undefined {
  if (continuation?.expiresAt && continuation.expiresAt > Date.now()) return continuation.context
  continuation = undefined
  try {
    const raw = sessionStorage.getItem(storageKey)
    if (!raw || raw.length > 256) return
    const value = JSON.parse(raw) as { traceparent?: string; expiresAt?: number }
    if (typeof value.expiresAt !== "number" || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + lifetime) return
    const context = readDiagnosticTraceparent(value.traceparent)
    if (context) continuation = { context, expiresAt: value.expiresAt }
    return context
  } catch { return undefined }
}

export function clearDiagnosticContinuation(): void {
  continuation = undefined
  try { sessionStorage.removeItem(storageKey) } catch { /* Optional diagnostics. */ }
}
