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
  const causeNames = errorCauseNames(error)
  const errorCode = safeJoinErrorCode(error) ?? (networkFailure ? "network-failure" : "admission-failure")
  meshTrace("workspace.join.host.failed", {
    stage, errorName, causeNames, errorCode, errorFrames: safeErrorFrames(error), admitted, networkFailure,
  }, "warn")
}

function errorCauseNames(error: unknown): string[] {
  const names: string[] = []
  let current: unknown = error
  while (current instanceof Error && names.length < 3) {
    current = current.cause
    if (current instanceof Error) {
      names.push(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(current.name) ? current.name : "Error")
    }
  }
  return names
}

function safeJoinErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    switch (current.message) {
      case "Mesh stream concurrency limit exceeded": return "stream-concurrency-limit"
      case "stream reset by peer: error 0": return "peer-stream-reset"
      case "failed to write stream chunk: connection lost": return "stream-write-connection-lost"
      case "failed to accept bidirectional stream: closed by peer: 0": return "stream-accept-peer-closed"
      case "failed to accept bidirectional stream: closed": return "stream-accept-closed"
    }
    current = current.cause
  }
  return undefined
}

function safeErrorFrames(error: unknown): string[] {
  const frames: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 4 && current instanceof Error && frames.length < 4; depth++) {
    const stackFrames = current.stack?.split("\n")
      .filter(frame => /^\s*at\s/.test(frame) || /^[^\s@]*@(?:https?:\/\/|file:\/\/|\/)/.test(frame)) ?? []
    frames.push(...stackFrames.slice(0, 4 - frames.length)
      .map(frame => frame.replace(/[?#][^\s)]*/g, "").slice(0, 240)))
    current = current.cause
  }
  return frames
}
