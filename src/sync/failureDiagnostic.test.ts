import { describe, expect, it } from "vitest"
import { MeshNetworkError, MeshTerminalError } from "@meta-uber/mesh-transport"
import { diagnosticErrorCode } from "./failureDiagnostic"
import { diagnosticEvent } from "./telemetryEvent"

const context = { project: "tincanban", sessionId: "session", deviceId: "device", timestamp: Date.now(), level: "warn" }

describe("safe failure diagnostics", () => {
  it.each([
    [new MeshNetworkError("private network endpoint"), "mesh_network_error"],
    [new MeshTerminalError("private authority value"), "mesh_terminal_error"],
    [Object.assign(new Error("private record"), { name: "WorkspaceChangeRejected" }), "workspace_change_rejected"],
    [new DOMException("private storage contents", "QuotaExceededError"), "quota_exceeded_error"],
    [new AggregateError([new MeshNetworkError("private route one"), new MeshNetworkError("private route two")]), "mesh_network_error"],
    [new AggregateError([new MeshNetworkError("private route"), new MeshTerminalError("private authority")]), "aggregate_error"],
  ])("Given a typed failure, When telemetry encodes it, Then its code survives without private error content", async (error, code) => {
    const event = await diagnosticEvent("workspace.frame.rejected", {
      error, reason: String(error),
    }, context)
    expect(event.attrs.error_code).toBe(code)
    expect(event.attrs.error_code).toMatch(/^[a-z][a-z0-9_.-]*$/)
    expect(JSON.stringify(event)).not.toContain("private")
  })

  it("Given a wrapped network failure, When classified, Then the underlying type remains visible", () => {
    const error = new Error("Workspace board-title snapshot failed", { cause: new MeshNetworkError("private peer") })
    expect(diagnosticErrorCode(error)).toBe("MeshNetworkError")
  })

  it("Given an unknown or cyclic failure, When classified, Then no dynamic name or content is exposed", () => {
    const unknown = Object.assign(new Error("private body"), { name: "PrivateUserValue" })
    const cycle = new Error("private cycle")
    cycle.cause = cycle
    expect(diagnosticErrorCode(unknown)).toBe("UnknownError")
    expect(diagnosticErrorCode(cycle)).toBe("UnknownError")
    expect(diagnosticErrorCode("private body")).toBe("UnknownError")
  })
})
