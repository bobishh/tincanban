/** Bound response bytes before parsing; private mail readers and public identity readers use distinct limits. */
export async function requestWorkerJson(origin: string, path: string, method: "GET" | "POST" | "PUT",
  maximumBytes: number, body?: unknown, invalidJsonMessage?: string): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, { method, mode: "cors", credentials: "omit", redirect: "error",
    signal: AbortSignal.timeout(method === "GET" ? 15_000 : 60_000), ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }) })
  return readWorkerJsonResponse(response, maximumBytes, invalidJsonMessage)
}

async function readWorkerJsonResponse(response: Response, maximumBytes: number,
  invalidJsonMessage = "Worker returned invalid JSON"): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error("Worker returned an empty response")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) { await reader.cancel(); throw new Error("Worker response exceeds the size limit") }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let parsed: unknown
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }
  catch { throw new Error(response.ok ? invalidJsonMessage : `Automation service is unavailable (HTTP ${response.status}). Retry the same operation.`) }
  if (!response.ok) {
    const message = parsed !== null && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string" ? parsed.error : `Worker returned ${response.status}`
    throw new Error(message)
  }
  return parsed
}
