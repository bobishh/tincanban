import { isMeshNetworkFailure } from "@meta-uber/mesh-transport"
import { meshTrace } from "./meshTrace"

/** A host-side join failure that must not be treated as a transient peer disconnect. */
export class WorkspaceAdmissionFailure extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = "WorkspaceAdmissionFailure"
  }
}

/** Trace a bounded, message-free failure classification and source frames for CI diagnosis. */
export function traceWorkspaceJoinFailure(error: unknown, stage: string, admitted: boolean): void {
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
    ? error.name : typeof error
  const networkFailure = isMeshNetworkFailure(error)
  const message = error instanceof Error ? error.message : ""
  const errorCode = safeJoinErrorCode(message) ?? (networkFailure ? "network-failure" : "admission-failure")
  meshTrace("workspace.join.host.failed", {
    stage, errorName, errorCode, errorFrames: safeErrorFrames(error), admitted, networkFailure,
  }, "warn")
}

function safeJoinErrorCode(message: string): string | undefined {
  switch (message) {
    case "Mesh stream concurrency limit exceeded": return "stream-concurrency-limit"
    case "stream reset by peer: error 0": return "peer-stream-reset"
    case "failed to write stream chunk: connection lost": return "stream-write-connection-lost"
    case "failed to accept bidirectional stream: closed by peer: 0": return "stream-accept-peer-closed"
    case "failed to accept bidirectional stream: closed": return "stream-accept-closed"
    default: return undefined
  }
}

function safeErrorFrames(error: unknown): string[] {
  if (!(error instanceof Error) || !error.stack) return []
  return error.stack.split("\n").slice(1)
    .filter(frame => /^\s*at\s/.test(frame))
    .slice(0, 4)
    .map(frame => frame.replace(/[?#][^\s)]*/g, "").slice(0, 240))
}
