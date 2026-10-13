/* global __TINCANBAN_BUILD_COMMIT__ */
import { diagnosticErrorCode } from "./failureDiagnostic"
type TelemetryAttrs = Record<string, string | number | string[]>
export type TelemetryEvent = {
  event_id: string; occurred_at: string; event: string; build: string
  session_id: string; device_id: string; workspace_id: string; entity_type: string; entity_id: string
  trace_id: string; span_id: string; parent_span_id: string
  component: string; operation: string; status: string; duration_ms: number; attrs: TelemetryAttrs
}
function diagnosticId(value: unknown, limit = 160): string {
  return typeof value === "string" && value.length <= limit && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : ""
}
function intakeIdentifier(value: unknown, limit = 64): string {
  if (typeof value !== "string") return ""
  const identifier = value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
  return identifier.length <= limit && /^[a-z][a-z0-9_.-]*$/.test(identifier) && !identifier.endsWith(".") && !identifier.includes("..") ? identifier : ""
}
const stringAttrs: Record<string, [string, number]> = {
  phase: ["phase", 64], transport: ["transport", 64], mode: ["mode", 64], connectionId: ["connection_id", 160], peerId: ["peer_id", 160],
  kind: ["frame_kind", 64], recovery: ["recovery", 64], changeId: ["change_id", 160],
  stage: ["stage", 64],
  browser: ["browser", 32], platform: ["platform", 32],
}
const numberAttrs: Record<string, string> = { attempt: "attempt", bytes: "bytes", peerCount: "peer_count", changeCount: "change_count",
  previousEpoch: "previous_epoch", currentEpoch: "current_epoch", admitted: "admitted", pending: "pending", quarantined: "quarantined", operationCount: "operation_count" }
function attributes(detail: Record<string, unknown>): TelemetryAttrs {
  const attrs: TelemetryAttrs = {}
  if (detail.error !== undefined) attrs.error_code = intakeErrorCode(diagnosticErrorCode(detail.error))
  // Opaque IDs retain case; intake error codes use lowercase identifiers.
  const errorCode = diagnosticId(detail.errorCode, 64)
  if (errorCode) attrs.error_code = intakeErrorCode(errorCode)
  for (const [key, [target, limit]] of Object.entries(stringAttrs)) {
    const value = ["connectionId", "peerId", "changeId"].includes(key) ? diagnosticId(detail[key], limit) : intakeIdentifier(detail[key], limit)
    if (value) attrs[target] = value
  }
  for (const [key, target] of Object.entries(numberAttrs)) {
    const value = detail[key]
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) attrs[target] = value
  }
  if (Array.isArray(detail.heads)) attrs.heads = detail.heads.slice(0, 32).map(value => diagnosticId(value)).filter(Boolean)
  if (Array.isArray(detail.changedFields)) attrs.changed_fields = detail.changedFields.map(value => intakeIdentifier(value)).filter(Boolean).slice(0, 16)
  return attrs
}
function intakeErrorCode(value: string): string {
  return intakeIdentifier(value) || "unknown_error"
}
export async function entityTraceId(project: string, workspace: string, type: string, id: string): Promise<string> {
  if (!id) return ""
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["MATCH-TELEMETRY/2", project, workspace, type, id])))
  return Array.from(new Uint8Array(hash).slice(0, 16), byte => byte.toString(16).padStart(2, "0")).join("")
}
function contextId(value: unknown, length: number): string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value) && !/^0+$/.test(value) ? value : ""
}
function outcome(event: string, detail: Record<string, unknown>, level: string): string {
  return intakeIdentifier(detail.outcome) || (level === "warn" || /failed|rejected/.test(event) ? "error" : "ok")
}
export async function diagnosticEvent(event: string, detail: Record<string, unknown>, context: { project: string; sessionId: string; deviceId: string; timestamp: number; level: string }): Promise<TelemetryEvent> {
  const entityId = diagnosticId(detail.entityId ?? detail.recordId)
  const entityType = intakeIdentifier(detail.entityType) || (event.startsWith("chat.") ? "message" : event.startsWith("document.") ? "change" : "")
  const workspaceId = diagnosticId(detail.workspaceId)
  return {
    event_id: crypto.randomUUID(), occurred_at: new Date(context.timestamp).toISOString(), event: intakeIdentifier(event, 160),
    build: typeof __TINCANBAN_BUILD_COMMIT__ === "undefined" ? "test" : __TINCANBAN_BUILD_COMMIT__,
    session_id: context.sessionId, device_id: diagnosticId(context.deviceId), workspace_id: workspaceId, entity_type: entityType, entity_id: entityId,
    trace_id: contextId(detail.traceId, 32) || await entityTraceId(context.project, workspaceId, entityType, entityId), span_id: contextId(detail.spanId, 16), parent_span_id: contextId(detail.parentSpanId, 16),
    component: intakeIdentifier(detail.component) || (event.startsWith("chat.") ? "chat" : "mesh"), operation: intakeIdentifier(detail.operation) || intakeIdentifier(event.split(".").at(-1)) || "diagnostic",
    status: outcome(event, detail, context.level),
    duration_ms: typeof detail.elapsedMs === "number" && Number.isFinite(detail.elapsedMs) ? Math.min(86_400_000, Math.max(0, detail.elapsedMs)) : 0,
    attrs: attributes(detail),
  }
}
