import { describe, expect, it } from "vitest"
import { MeshNetworkError, MeshTerminalError } from "@meta-uber/mesh-transport"
import { diagnosticErrorCode } from "./failureDiagnostic"

describe("safe failure diagnostics", () => {
  it.each([
    [new MeshNetworkError("private network endpoint"), "mesh_network_error"],
    [new MeshTerminalError("private authority value"), "mesh_terminal_error"],
    [Object.assign(new Error("private record"), { name: "WorkspaceChangeRejected" }), "workspace_change_rejected"],
    [new DOMException("private storage contents", "QuotaExceededError"), "quota_exceeded_error"],
    [new AggregateError([new MeshNetworkError("private route one"), new MeshNetworkError("private route two")]), "mesh_network_error"],
    [new AggregateError([new MeshNetworkError("private route"), new MeshTerminalError("private authority")]), "aggregate_error"],
  ])("Given a typed failure, When classified, Then its stable code survives without user-defined names", (error, code) => {
    expect(diagnosticErrorCode(error)).toBe(code.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()).replace(/^./, letter => letter.toUpperCase()).replace("Wasm", "Wasm"))
  })

  it("Given a wrapped network failure, When classified, Then the underlying type remains visible", () => {
    const error = new Error("Workspace board-title snapshot failed", { cause: new MeshNetworkError("private peer") })
    expect(diagnosticErrorCode(error)).toBe("MeshNetworkError")
  })

  it.each([
    [new WebAssembly.RuntimeError("private WASM panic"), "WasmRuntimeError"],
    [new Error("Module terminated"), "WasmModuleTerminated"],
    [new DOMException("private clone payload", "DataCloneError"), "DataCloneError"],
    [new TypeError("private board title"), "TypeError"],
    [new RangeError("private item content"), "RangeError"],
    [new Error("outer wrapper", { cause: new WebAssembly.RuntimeError("private WASM panic") }), "WasmRuntimeError"],
  ])("Given a runtime or platform failure, When classified, Then its stable type is retained", (error, code) => {
    expect(diagnosticErrorCode(error)).toBe(code)
  })

  it("Given a message that resembles module termination but adds context, When classified, Then arbitrary wording stays unknown", () => {
    expect(diagnosticErrorCode(new Error("Module terminated while rendering private board 123"))).toBe("UnknownError")
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
