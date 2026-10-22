import { meshTrace, type MeshTraceLevel } from "./meshTrace"
import { beginDiagnosticOperation, record, traceDiagnosticOperation } from "./telemetry"
import { invitationUrl, type DeviceEnrollmentInvitation } from "@meta-uber/mesh-pairing"
import { ROOT_CONTEXT, type Context } from "@opentelemetry/api"
import { readDiagnosticTraceparent, rememberDiagnosticContinuation } from "./diagnosticTraceContext"
import { toRaw } from "vue"

type Diagnostic = Awaited<ReturnType<typeof beginDiagnosticOperation>>
const diagnostics = new WeakMap<DeviceEnrollmentInvitation, { parent?: Context; operation?: Diagnostic }>()

export function captureEnrollmentDiagnosticContext(invite: DeviceEnrollmentInvitation, url: string): void {
  try {
    const parsed = new URL(url, "https://pair.invalid")
    const parent = readDiagnosticTraceparent(new URLSearchParams(parsed.hash.slice(1)).get("traceparent"))
    if (parent) diagnostics.set(toRaw(invite), { parent })
  } catch { /* Diagnostics never affect invitation validation. */ }
}

export async function beginEnrollmentDiagnostic(invite: DeviceEnrollmentInvitation, role: "host" | "guest"): Promise<void> {
  const operation = await beginDiagnosticOperation(`enrollment.${role}`, { "sync.enrollment.id": invite.invitationId },
    role === "guest" ? diagnostics.get(toRaw(invite))?.parent ?? ROOT_CONTEXT : ROOT_CONTEXT)
  diagnostics.set(toRaw(invite), { operation })
  rememberDiagnosticContinuation(operation.context)
}

export function endEnrollmentDiagnostic(invite: DeviceEnrollmentInvitation | undefined, error?: unknown): void {
  if (invite) diagnostics.get(toRaw(invite))?.operation?.end(error)
}

export function enrollmentDiagnosticUrl(origin: string, invite: DeviceEnrollmentInvitation): string {
  const url = new URL(invitationUrl(origin, invite))
  const traceparent = diagnostics.get(toRaw(invite))?.operation?.traceparent
  if (traceparent) {
    const fragment = new URLSearchParams(url.hash.slice(1))
    fragment.set("traceparent", traceparent)
    url.hash = fragment.toString()
  }
  return url.href
}

export function traceEnrollmentOperation<T>(invite: DeviceEnrollmentInvitation, phase: string,
  operation: (context?: Context) => Promise<T> | T): Promise<T> {
  return traceDiagnosticOperation(`enrollment.${phase}`, { "sync.enrollment.id": invite.invitationId }, operation,
    diagnostics.get(toRaw(invite))?.operation?.context)
}

export function enrollmentErrorReason(error: unknown, depth = 0): string {
  const message = error instanceof Error ? error.message : String(error)
  if (depth >= 4) return message
  if (error instanceof AggregateError) return `${message}: ${error.errors.map(cause => enrollmentErrorReason(cause, depth + 1)).join("; ")}`
  return error instanceof Error && error.cause !== undefined ? `${message}: ${enrollmentErrorReason(error.cause, depth + 1)}` : message
}

/** Export protocol phases without requiring a diagnostic URL or exposing the invitation. */
export function traceEnrollment(invite: DeviceEnrollmentInvitation | undefined, role: "host" | "guest", event: string, run: number,
  detail: Record<string, unknown> = {}, level: MeshTraceLevel = "info") {
  meshTrace(`enrollment.${role}.${event}`, { runId: run, ...detail, ...(invite ? { "sync.enrollment.id": invite.invitationId } : {}) }, level)
  try {
    record(`enrollment.${role}.${event}`, { phase: `${role}.${event}`,
      ...(invite ? { "sync.enrollment.id": invite.invitationId } : {}),
      ...(typeof detail.attempt === "number" ? { attempt: detail.attempt } : {}),
      ...(typeof detail.workspaces === "number" ? { count: detail.workspaces } : {}),
      ...(typeof detail.reason === "string" ? { error: new Error(detail.reason) } : {}) }, level,
      invite ? diagnostics.get(toRaw(invite))?.operation?.context : undefined)
  } catch { /* Diagnostics must not interrupt enrollment. */ }
}
