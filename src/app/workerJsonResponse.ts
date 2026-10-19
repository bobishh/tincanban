import { withRecoveryCheckpoint } from "../sync/recoveryDiagnostics"
import { record, traceDiagnosticOperation } from "../sync/telemetry"

type RequestTrace = { action: string; detail: Record<string, string | number> }
function managementTrace(origin: string, path: string): RequestTrace | undefined {
  const action = path === "/v2/capabilities" ? "capabilities" :
    /^\/v2\/automation-instances\/(discover|identity|activate|refresh-access|prepare-storage-rotation|rotate-storage|prepare-history-baseline|activate-history-baseline)$/.exec(path)?.[1]
  return action ? { action, detail: { "server.address": new URL(origin).host, "code.operation": action } } : undefined
}
async function stage<T>(trace: RequestTrace | undefined, phase: string, operation: () => Promise<T> | T): Promise<T> {
  if (!trace) return await operation()
  const name = `automation.management.${trace.action}.${phase}`, detail = { ...trace.detail, phase }
  try { record(`${name}.started`, detail) } catch { /* Diagnostics preserve transport behavior. */ }
  const value = await traceDiagnosticOperation(name, detail, () => withRecoveryCheckpoint(name, detail, operation))
  try { record(`${name}.completed`, { ...trace.detail, phase }) } catch { /* Diagnostics preserve transport behavior. */ }
  return value
}

/** Bound response bytes before parsing; private mail readers and public identity readers use distinct limits. */
export async function requestWorkerJson(origin: string, path: string, method: "GET" | "POST" | "PUT",
  maximumBytes: number, body?: unknown, invalidJsonMessage?: string): Promise<unknown> {
  const trace = managementTrace(origin, path)
  const encoded = body === undefined ? undefined : await stage(trace, "serializeRequest", () => JSON.stringify(body))
  const response = await stage(trace, "fetchHeaders", () => fetch(`${origin}${path}`, { method, mode: "cors", credentials: "omit", redirect: "error",
    signal: AbortSignal.timeout(method === "GET" ? 15_000 : 60_000), ...(encoded === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: encoded,
    }) }))
  if (trace) trace.detail["http.response.status_code"] = response.status
  return readWorkerJsonResponse(response, maximumBytes, invalidJsonMessage, trace)
}

async function readWorkerJsonResponse(response: Response, maximumBytes: number,
  invalidJsonMessage = "Worker returned invalid JSON", trace?: RequestTrace): Promise<unknown> {
  const bytes = await stage(trace, "readBody", () => readBoundedBody(response, maximumBytes, trace))
  const parsed = await stage(trace, "parseJson", () => {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }
    catch { throw new Error(response.ok ? invalidJsonMessage : `Automation service is unavailable (HTTP ${response.status}). Retry the same operation.`) }
  })
  if (!response.ok) {
    const message = parsed !== null && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string" ? parsed.error : `Worker returned ${response.status}`
    throw new Error(message)
  }
  return parsed
}

async function readBoundedBody(response: Response, maximumBytes: number, trace?: RequestTrace): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Worker returned an empty response")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (trace && !chunks.length) {
        try { record(`automation.management.${trace.action}.firstBodyBytes`, { ...trace.detail, bytes: size }) }
        catch { /* Diagnostics preserve stream handling. */ }
      }
      if (size > maximumBytes) { await reader.cancel(); throw new Error("Worker response exceeds the size limit") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  if (trace) trace.detail.bytes = size
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}
