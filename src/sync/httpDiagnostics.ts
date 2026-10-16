import type { Context } from "@opentelemetry/api"

export type HttpDiagnosticSpan = { headers: Record<string, string>; end: (error?: unknown, statusCode?: number) => void }
export type HttpDiagnosticSpanFactory = (name: string, attributes: Record<string, string | number>, parent?: Context) => HttpDiagnosticSpan | undefined

let factory: HttpDiagnosticSpanFactory | undefined

export function setHttpDiagnosticSpanFactory(next: HttpDiagnosticSpanFactory | undefined): void {
  factory = next
}

/** Optional producer hook; callers can keep HTTP work independent from diagnostics. */
export function beginDiagnosticHttpRequest(name: string, attributes: Record<string, string | number> = {}, parent?: Context): HttpDiagnosticSpan {
  try {
    return factory?.(name, attributes, parent) ?? { headers: {}, end: () => {} }
  } catch {
    return { headers: {}, end: () => {} }
  }
}
