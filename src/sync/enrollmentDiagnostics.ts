import { meshTrace, type MeshTraceLevel } from "./meshTrace"
import { record } from "./telemetry"

/** Export protocol phases without requiring a diagnostic URL or exposing the invitation. */
export function traceEnrollment(role: "host" | "guest", event: string, run: number,
  detail: Record<string, unknown> = {}, level: MeshTraceLevel = "info") {
  meshTrace(`enrollment.${role}.${event}`, { runId: run, ...detail }, level)
  try {
    record(`enrollment.${role}.${event}`, { phase: `${role}.${event}`,
      ...(typeof detail.attempt === "number" ? { attempt: detail.attempt } : {}),
      ...(typeof detail.workspaces === "number" ? { count: detail.workspaces } : {}),
      ...(typeof detail.reason === "string" ? { error: new Error(detail.reason) } : {}) }, level)
  } catch { /* Diagnostics must not interrupt enrollment. */ }
}
