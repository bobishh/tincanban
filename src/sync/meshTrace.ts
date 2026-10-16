import { MeshTraceBuffer, type MeshTraceEvent, type MeshTraceLevel } from "@meta-uber/mesh-transport"

export type { MeshTraceEvent, MeshTraceLevel }

let verboseConsoleLogging = typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("syncTrace") === "1"
const traceBuffer = new MeshTraceBuffer("tincanban.mesh", 500, {
  info: line => { if (verboseConsoleLogging) console.info(line) },
  warn: line => console.warn(line),
})

/** Keeps routine mesh events out of the console while retaining them for diagnostic snapshots. */
export function setMeshTraceVerboseLogging(enabled: boolean) {
  verboseConsoleLogging = enabled
}

export function meshTrace(event: string, detail: Record<string, unknown> = {}, level: MeshTraceLevel = "info", error?: unknown) {
  traceBuffer.trace(event, detail, level)
  if (typeof window !== "undefined") {
    const timestampMs = Date.now()
    void import("./telemetry").then(module => module.record(event, { timestampMs, ...detail, error: error ?? detail.error }, level)).catch(() => {})
  }
}

export function meshTraceSnapshot(): MeshTraceEvent[] {
  return traceBuffer.snapshot()
}

export function clearMeshTrace() {
  traceBuffer.clear()
}
