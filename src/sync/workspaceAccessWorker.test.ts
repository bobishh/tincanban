import { WasmStateCore } from "@meta-uber/mesh-transport/wasm"
import { afterEach, expect, it, vi } from "vitest"
import type { AccessWorkerRequest } from "./workspaceAccess"
const stages = vi.hoisted(() => [] as string[])
vi.mock("./startupDiagnostics", () => ({
  diagnoseStartupStep: async (stage: string, step: () => unknown) => {
    stages.push(`${stage}:started`)
    const result = await step()
    stages.push(`${stage}:completed`)
    return result
  },
}))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it("Given transferred document bytes, When checking worker access, Then the policy receives its original numeric document format", async () => {
  const decision = vi.spyOn(WasmStateCore, "decideWorkspaceAccess").mockImplementation(input => {
    expect(stages).toEqual(["access-worker-wasm:started", "access-worker-wasm:completed",
      "access-worker-decode:started", "access-worker-decode:completed", "access-worker-decide:started"])
    expect(input.snapshot.document).toEqual([1, 2, 3])
    expect(Array.isArray(input.snapshot.document)).toBe(true)
    return "owner"
  })
  const { decideWorkspaceAccessInWorker } = await import("./workspaceAccessWorker")
  const request: AccessWorkerRequest = { id: 17, diagnosticsEnabled: true, input: { snapshot: { document: new Uint8Array([1, 2, 3]) } } }
  const response = decideWorkspaceAccessInWorker(request, Promise.resolve({ memory: new WebAssembly.Memory({ initial: 1 }) }))
  await expect(response).resolves.toEqual({ id: 17, role: "owner" })
  expect(decision).toHaveBeenCalledTimes(1)
})
