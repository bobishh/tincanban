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

/** Host adapter supplies transport; diagnostics never replace its response or failure. */
export async function diagnosticHttpRequest(url: string, init: RequestInit,
  request: (url: string, init: RequestInit) => Promise<Response>, parent?: Context): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase()
  const diagnostic = beginDiagnosticHttpRequest(`HTTP ${method}`, {
    "http.request.method": method, "server.address": new URL(url).host,
  }, parent)
  const headers = new Headers(init.headers)
  for (const [key, value] of Object.entries(diagnostic.headers)) headers.set(key, value)
  let status: number | undefined
  let failure: unknown
  try {
    const response = await request(url, { ...init, headers })
    status = response.status
    return response
  } catch (error) {
    failure = error
    throw error
  } finally {
    try { diagnostic.end(failure, status) } catch { /* Diagnostics preserve the transport result. */ }
  }
}
